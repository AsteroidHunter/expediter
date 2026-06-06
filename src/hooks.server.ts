import type { Handle } from '@sveltejs/kit';
import { timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { getServerToken } from '$lib/token';
import { runBootScan } from '$lib/server/bootScan';

// Boot-time session enumeration. Runs once per server-module load so the dock
// reflects every claude session currently in tmux at daemon start, not just
// the ones that have recently emitted a hook event. Errors are swallowed so a
// missing tmux server (or any other failure mode) doesn't crash daemon
// startup. Skipped under NODE_ENV=test (Bun sets this automatically) so test
// imports of hooks.server.ts don't mutate the in-memory ticket store or shell
// out to tmux.
if (process.env.NODE_ENV !== 'test') {
	void runBootScan().catch((e) => console.warn('[bootScan]', e));
}

// adapter-node honors EXPEDITER_* envs because svelte.config.js sets envPrefix.
// Each of these would silently switch getClientAddress() or event.url.host to a
// header-derived value, making the gate header-spoofable. Warn loudly if set.
const DANGEROUS_ADAPTER_ENV = [
	'EXPEDITER_ADDRESS_HEADER',
	'EXPEDITER_HOST_HEADER',
	'EXPEDITER_PROTOCOL_HEADER',
	'EXPEDITER_ORIGIN'
] as const;

for (const key of DANGEROUS_ADAPTER_ENV) {
	if (process.env[key]) {
		console.warn(
			`[gate] WARNING: ${key} is set; this corrupts the origin gate and must be unset.`
		);
	}
}

const PORT = (process.env.EXPEDITER_PORT ?? '5179').trim();

// Opt-in per-request gate tracing for "phone can't connect" debugging. Gated on
// DEBUG_EXPEDITER — deliberately NOT an EXPEDITER_* name, since adapter-node's
// build/env.js throws at import on any unknown EXPEDITER_* var and would crash
// the daemon. Logs to stderr (inherited by the launcher terminal). When this is
// silent for a phone request, the request never reached the daemon at all (DNS/
// mDNS, firewall, wrong IP, or wrong network) — look at the launcher's URL log.
const DEBUG = !!process.env.DEBUG_EXPEDITER;
function dbg(...args: unknown[]) {
	if (DEBUG) console.error('[gate:debug]', ...args);
}

type IpRule =
	| { kind: 'exact'; value: string }
	| { kind: 'cidr'; base: string; bits: number };

// Loopback only. After the design pivot to per-restart in-memory token, the IP
// allowlist no longer rejects general traffic — the token is the auth
// boundary. These constants survive as input to the /api/token route's
// loopback check and the /api/hooks/event loopback bypass in `handle` below.
export const IP_ALLOWLIST: IpRule[] = [
	{ kind: 'exact', value: '127.0.0.1' },
	{ kind: 'exact', value: '::1' }
];

export function normalizeIp(addr: string | null | undefined): string | null {
	if (!addr) return null;
	if (addr.startsWith('::ffff:')) return addr.slice('::ffff:'.length);
	return addr;
}

function ipToInt(ip: string): number {
	const parts = ip.split('.');
	if (parts.length !== 4) return NaN;
	let n = 0;
	for (const p of parts) {
		if (!/^\d{1,3}$/.test(p)) return NaN;
		const o = Number(p);
		if (o < 0 || o > 255) return NaN;
		n = (n << 8) | o;
	}
	return n >>> 0;
}

function inCidr(ip: string, baseIp: string, bits: number): boolean {
	if (bits === 0) return true;
	const a = ipToInt(ip);
	const b = ipToInt(baseIp);
	if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
	const shift = 32 - bits;
	return (a >>> shift) === (b >>> shift);
}

export function isAllowedIp(ip: string | null): boolean {
	if (!ip) return false;
	for (const rule of IP_ALLOWLIST) {
		if (rule.kind === 'exact' && rule.value === ip) return true;
		if (rule.kind === 'cidr' && inCidr(ip, rule.base, rule.bits)) return true;
	}
	return false;
}

// Host header check. After the design pivot, accepts any RFC1918 or link-local
// IPv4 at the configured port plus loopback literals and `<name>.local` mDNS
// hostnames. Token gate is the actual auth; this is cheap defense-in-depth
// against DNS rebinding from arbitrary Host headers pointing at the daemon's
// LAN IP.
const HOST_LITERALS = new Set<string>([
	`localhost:${PORT}`,
	`127.0.0.1:${PORT}`,
	`[::1]:${PORT}`
]);

// One regex per RFC1918 / link-local range, anchored on full string and the
// configured port. Each octet is range-checked separately below to reject
// values >255 (the regex's \d{1,3} would accept up to 999).
const HOST_IP_PATTERNS: RegExp[] = [
	new RegExp(`^10\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}:${PORT}$`),
	new RegExp(`^172\\.(?:1[6-9]|2\\d|3[01])\\.\\d{1,3}\\.\\d{1,3}:${PORT}$`),
	new RegExp(`^192\\.168\\.\\d{1,3}\\.\\d{1,3}:${PORT}$`),
	new RegExp(`^169\\.254\\.\\d{1,3}\\.\\d{1,3}:${PORT}$`)
];

// Single-label `<name>.local` mDNS hostname at the configured port. The label
// rule is RFC 1035 / 952: leading + trailing alphanumeric, hyphens permitted
// inside, 1-63 chars total. Case-insensitive match — we lowercase the host
// before testing.
const HOST_MDNS_PATTERN = new RegExp(
	`^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.local:${PORT}$`
);

export function isAllowedHost(host: string | null): boolean {
	if (!host) return false;
	const h = host.toLowerCase();
	if (HOST_LITERALS.has(h)) return true;
	if (HOST_MDNS_PATTERN.test(h)) return true;
	for (const re of HOST_IP_PATTERNS) {
		if (!re.test(h)) continue;
		const ipPart = h.split(':')[0];
		const octets = ipPart.split('.');
		if (octets.length === 4 && octets.every((o) => Number(o) <= 255)) return true;
	}
	return false;
}

function frameDeny(response: Response): Response {
	response.headers.set('x-frame-options', 'DENY');
	return response;
}

function reject(reason: string, ctx: { host: string | null; ip: string | null; path: string }): Response {
	console.warn(
		`[gate] reject reason=${reason} host=${ctx.host ?? '<none>'} ip=${ctx.ip ?? '<none>'} path=${ctx.path}`
	);
	return new Response(null, { status: 403, headers: { 'x-frame-options': 'DENY' } });
}

function extractToken(pathname: string, headers: Headers, searchParams: URLSearchParams): string | null {
	const headerToken = headers.get('x-expediter-token');
	// /api/stream accepts ?t= because EventSource can't set custom headers.
	// Header still wins if both are supplied (test 2.5).
	if (pathname === '/api/stream') {
		return headerToken ?? searchParams.get('t');
	}
	return headerToken;
}

function constantTimeEqual(a: string, b: string): boolean {
	const aBuf = Buffer.from(a, 'utf8');
	const bBuf = Buffer.from(b, 'utf8');
	if (aBuf.length !== bBuf.length) return false;
	return timingSafeEqual(aBuf, bBuf);
}

export const handle: Handle = async ({ event, resolve }) => {
	const host = event.request.headers.get('host');
	let ip: string | null = null;
	try {
		ip = normalizeIp(event.getClientAddress());
	} catch {
		ip = null;
	}

	const pathname = event.url.pathname;
	const loggedPath =
		pathname === '/api/stream' && event.url.searchParams.has('t')
			? `${pathname}?t=<redacted>`
			: pathname;

	// One line per inbound request, before any decision. This is the line that
	// tells you a phone request actually arrived — and exactly which Host header
	// and peer IP it presented, the two values the gate decides on.
	dbg(
		`IN ${event.request.method} path=${loggedPath} host=${host ?? '<none>'} ip=${ip ?? '<none>'} ` +
			`hostAllowed=${isAllowedHost(host)} ipAllowed=${isAllowedIp(ip)} hasHeaderToken=${!!event.request.headers.get('x-expediter-token')}`
	);

	if (!isAllowedHost(host)) {
		return reject('host-rejected', { host, ip, path: loggedPath });
	}

	// Page + static assets are public — the URL fragment with the token is never
	// sent to the server, so the page must load to expose the fragment-grab
	// snippet that stashes the token in sessionStorage.
	if (!pathname.startsWith('/api/')) {
		dbg(`ACCEPT path=${loggedPath} reason=public-asset`);
		return frameDeny(await resolve(event));
	}

	// /api/token defers to its route handler, which does its own loopback check
	// (the caller cannot provide a token before they have one).
	if (pathname === '/api/token') {
		dbg(`ACCEPT path=${loggedPath} reason=token-route (route does its own loopback check)`);
		return frameDeny(await resolve(event));
	}

	// /api/hooks/event from loopback bypasses the token check — the hook script
	// runs on the daemon's host and is trusted by virtue of loopback origin.
	// Any process that can bind to 127.0.0.1 on this Mac is already running as
	// the user; the token gate's job is to extend trust selectively to the
	// phone, not to defend against the user's own local processes.
	if (pathname === '/api/hooks/event' && isAllowedIp(ip)) {
		dbg(`ACCEPT path=${loggedPath} reason=loopback-hook`);
		return frameDeny(await resolve(event));
	}

	const provided = extractToken(pathname, event.request.headers, event.url.searchParams);
	if (!provided) {
		return reject('token-missing', { host, ip, path: loggedPath });
	}

	if (!constantTimeEqual(provided, getServerToken())) {
		return reject('token-mismatch', { host, ip, path: loggedPath });
	}

	dbg(`ACCEPT path=${loggedPath} reason=token-ok`);
	return frameDeny(await resolve(event));
};
