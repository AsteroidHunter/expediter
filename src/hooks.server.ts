import type { Handle } from '@sveltejs/kit';

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

type IpRule =
	| { kind: 'exact'; value: string }
	| { kind: 'cidr'; base: string; bits: number };

// 172.20.10.0/28 is the legacy iOS hotspot subnet. 192.0.0.0/29 is iOS 17+
// USB-tether (Mac gets .2, iPhone is .1). 192.168.42.0/24 is Android USB tether.
const IP_ALLOWLIST: IpRule[] = [
	{ kind: 'exact', value: '127.0.0.1' },
	{ kind: 'exact', value: '::1' },
	{ kind: 'cidr', base: '172.20.10.0', bits: 28 },
	{ kind: 'cidr', base: '192.0.0.0', bits: 29 },
	{ kind: 'cidr', base: '192.168.42.0', bits: 24 }
];

function normalizeIp(addr: string | null | undefined): string | null {
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

function isAllowedIp(ip: string | null): boolean {
	if (!ip) return false;
	for (const rule of IP_ALLOWLIST) {
		if (rule.kind === 'exact' && rule.value === ip) return true;
		if (rule.kind === 'cidr' && inCidr(ip, rule.base, rule.bits)) return true;
	}
	return false;
}

const HOST_EXACT = new Set<string>([
	`localhost:${PORT}`,
	`127.0.0.1:${PORT}`,
	`[::1]:${PORT}`
]);

const TETHER_HOST_PATTERNS: Array<{ re: RegExp; max: number }> = [
	{ re: new RegExp(`^172\\.20\\.10\\.(\\d{1,3}):${PORT}$`), max: 15 },
	{ re: new RegExp(`^192\\.0\\.0\\.(\\d{1,3}):${PORT}$`), max: 7 },
	{ re: new RegExp(`^192\\.168\\.42\\.(\\d{1,3}):${PORT}$`), max: 255 }
];

function isAllowedHost(host: string | null): boolean {
	if (!host) return false;
	const h = host.toLowerCase();
	if (HOST_EXACT.has(h)) return true;
	for (const { re, max } of TETHER_HOST_PATTERNS) {
		const m = h.match(re);
		if (m) {
			const n = Number(m[1]);
			if (Number.isInteger(n) && n >= 0 && n <= max) return true;
		}
	}
	return false;
}

export const handle: Handle = async ({ event, resolve }) => {
	const host = event.request.headers.get('host');
	let ip: string | null = null;
	try {
		ip = normalizeIp(event.getClientAddress());
	} catch {
		ip = null;
	}

	if (!isAllowedHost(host) || !isAllowedIp(ip)) {
		console.warn(
			`[gate] reject host=${host ?? '<none>'} ip=${ip ?? '<none>'} path=${event.url.pathname}`
		);
		return new Response(null, { status: 403 });
	}

	return resolve(event);
};
