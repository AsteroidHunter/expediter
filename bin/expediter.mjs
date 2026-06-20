#!/usr/bin/env bun
// expediter — start (or detect) the daemon, then print the tether URL + QR.
//
// Run from anywhere via the ~/.local/bin/expediter shim installed by install.sh.
// The shim sets EXPEDITER_HOME to the cloned-repo path, which is where this
// script and the SvelteKit build at $EXPEDITER_HOME/build/index.js live.

import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import qrcode from 'qrcode-terminal';
import { resolveTransport, accessUrl } from '../src/lib/server/transport.ts';
import { tailscaleIPv4s, leafCoversIp } from '../src/lib/server/cert.ts';

const PORT = process.env.EXPEDITER_PORT ?? '5179';
const HOME = process.env.EXPEDITER_HOME;
const PRINT_URL = process.argv.includes('--print-url');
const SHOW_HELP = process.argv.includes('--help') || process.argv.includes('-h');
const TITLE_IDX = process.argv.indexOf('--title');
const TITLE_VALUE = TITLE_IDX >= 0 ? process.argv[TITLE_IDX + 1] : null;
const CONFIG_FILE = path.join(os.homedir(), '.expediter', 'config.json');
const HTTP_FLAG = process.argv.includes('--http');
const HTTPS_FLAG = process.argv.includes('--https');
// --tailscale advertises the Mac's tailnet address in the QR instead of the
// LAN IP. Per-run (not sticky): the LAN QR is the right default at home, and a
// stale sticky tailnet QR would silently dead-end a phone with Tailscale off.
const TAILSCALE_FLAG = process.argv.includes('--tailscale');
// Resolved in main() from the flags above + the saved preference; module-scoped
// so isDaemonUp / fetchToken / printAccess all speak the same scheme.
let transport = 'https';
// --steps "<s1>|<s2>|..." — opt-in numbered-steps list appended below the QR.
// Used by `claudex uno` to print newbie-onboarding instructions. Plain
// `expediter` without --steps never prints steps. Steps are pipe-delimited;
// each step renders on its own line prefixed with "<n>. " (1-indexed).
const STEPS_IDX = process.argv.indexOf('--steps');
const STEPS_RAW = STEPS_IDX !== -1 ? process.argv[STEPS_IDX + 1] : undefined;

// Opt-in diagnostics for "phone can't connect" debugging. Gated on
// DEBUG_EXPEDITER (NOT an EXPEDITER_* name — adapter-node's build/env.js throws
// on any unknown EXPEDITER_* var, which would crash the daemon). Goes to stderr
// so it never corrupts the QR/URL on stdout.
const DEBUG = !!process.env.DEBUG_EXPEDITER;
function dbg(...args) {
	if (DEBUG) console.error('[expediter:debug]', ...args);
}
// Strip the token fragment so debug output is safe to paste into a chat.
function redactUrl(u) {
	return u ? u.replace(/#.*/, '#<token>') : u;
}

// `expediter update [--dev|--no-pull|...]` refreshes this install by running
// update.sh in EXPEDITER_HOME and passing through any extra flags. Handled
// before anything else so it never starts the daemon. update.sh pulls the
// latest by default; --dev / --no-pull skips the pull and rebuilds the current
// checkout (what you want when updating from a feature branch / worktree).
if (process.argv[2] === 'update') {
	if (!HOME) {
		console.error('expediter: EXPEDITER_HOME is not set. Re-run install.sh from the cloned repo.');
		process.exit(1);
	}
	const res = spawnSync(path.join(HOME, 'update.sh'), process.argv.slice(3), {
		stdio: 'inherit',
	});
	if (res.error) {
		console.error(`expediter update: could not run update.sh (${res.error.message})`);
		process.exit(1);
	}
	process.exit(res.status ?? 1);
}

if (SHOW_HELP) {
	console.log(
		'Usage: expediter [--http|--https] [--tailscale] [--print-url] [--title default|haiku] [--steps "..."] [--help]'
	);
	console.log('   or: expediter update [--dev]');
	console.log('');
	console.log('  update                 Pull the latest and rebuild in place.');
	console.log('                         Add --dev (or --no-pull) to skip the pull and rebuild the');
	console.log('                         current checkout, e.g. when updating from a feature branch.');
	console.log('  --print-url            Also print the tethered URL as text (default: QR only).');
	console.log('                         Use this only if your phone cannot scan the QR — the URL');
	console.log('                         contains the session token and will stay in scrollback.');
	console.log('  --title default|haiku  Set the ticket title source and exit.');
	console.log('                         "default" uses the Claude chat title (auto-titled or via');
	console.log('                         /rename), with a whimsical name as fallback. "haiku" uses');
	console.log('                         the LLM-generated caveman summary. Writes to');
	console.log('                         ~/.expediter/config.json.');
	console.log('  --steps                Pipe-delimited list of numbered steps to print below the QR.');
	console.log('                         Opt-in; used by `claudex uno` for newbie-onboarding.');
	console.log('  --http, --https        Pick the connection transport (sticky, saved to config.json).');
	console.log('                         HTTPS is the default and is required for the microphone /');
	console.log('                         voice feature and PWA install; the phone does a one-time');
	console.log('                         in-browser certificate trust step. --http opts out to a plain');
	console.log('                         connection with no certificate (and no microphone).');
	console.log('  --tailscale            Put this Mac\'s Tailscale address in the QR instead of the LAN');
	console.log('                         IP, so a phone on your tailnet can connect from any network.');
	console.log('                         Applies to this run only (not sticky); requires Tailscale');
	console.log('                         connected on both devices. Combines with --http/--https.');
	console.log('  --help, -h             Show this message.');
	process.exit(0);
}

if (TITLE_IDX >= 0) {
	const map = { default: 'chat-title', haiku: 'haiku' };
	const internal = map[TITLE_VALUE];
	if (!internal) {
		console.error(
			`expediter: --title requires 'default' or 'haiku' (got: ${TITLE_VALUE ?? '<missing>'})`
		);
		process.exit(1);
	}
	const dir = path.join(os.homedir(), '.expediter');
	const file = path.join(dir, 'config.json');
	let existing = {};
	try {
		const raw = await fs.readFile(file, 'utf8');
		const parsed = JSON.parse(raw);
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
			existing = parsed;
		}
	} catch {
		// file missing or malformed — overwrite with a fresh object
	}
	existing.title_source = internal;
	await fs.mkdir(dir, { recursive: true });
	await fs.writeFile(file, JSON.stringify(existing, null, 2) + '\n', 'utf8');
	const message =
		TITLE_VALUE === 'haiku'
			? 'expediter: ticket titles will now be generated by Haiku'
			: "expediter: ticket titles will now use a placeholder or the claude session's name.";
	console.log(message);
	process.exit(0);
}

if (!HOME) {
	console.error('expediter: EXPEDITER_HOME is not set. Re-run install.sh from the cloned repo.');
	process.exit(1);
}

// --- pick the URL the phone should hit ---
// Wireless first: standard LAN ranges rank ahead of USB-tether subnets. The
// tether-specific patterns (172.20.10.x, 192.0.0.x, 192.168.42.x) are subsets
// of broader RFC1918 ranges, so they must be checked first — otherwise the
// generic RFC1918 match would score them as standard LAN.
function score(addr) {
	// USB-tether subnets (specific) → rank below standard LAN
	if (addr.startsWith('172.20.10.')) return 2;
	if (addr.startsWith('192.0.0.')) return 2;
	if (addr.startsWith('192.168.42.')) return 2;

	// Standard LAN (RFC1918)
	if (addr.startsWith('192.168.')) return 0;
	if (addr.startsWith('10.')) return 0;
	if (/^172\.(1[6-9]|2\d|3[01])\./.test(addr)) return 0;

	// Link-local — last resort
	if (addr.startsWith('169.254.')) return 3;
	return 4;
}

// VPN / tunnel interfaces carry addresses a LAN phone can never route to: a Mac
// on a WireGuard/Tailscale/corporate VPN gets a 10.x tunnel address that scores
// as "standard LAN" and wins over the real Wi-Fi interface, so the QR advertises
// a dead URL and the phone loads a blank page. Skip them by interface name —
// utun*/ipsec*/ppp*/tun*/tap*/wg* — so only physically reachable addresses
// remain.
const TUNNEL_IFACE = /^(utun|ipsec|ppp|tun|tap|wg)\d*$/i;

function pickTetherAddress() {
	const ifaces = os.networkInterfaces();
	const candidates = [];
	for (const [name, addrs] of Object.entries(ifaces)) {
		if (!addrs) continue;
		if (TUNNEL_IFACE.test(name)) {
			dbg(`pickTetherAddress: skipping tunnel interface ${name}`);
			continue;
		}
		for (const a of addrs) {
			if (a.family !== 'IPv4' || a.internal) continue;
			candidates.push(a.address);
		}
	}
	if (candidates.length === 0) {
		dbg('pickTetherAddress: no external IPv4 interfaces found');
		return null;
	}
	candidates.sort((a, b) => score(a) - score(b));
	dbg(
		'pickTetherAddress candidates (lower score wins):',
		candidates.map((a) => `${a}=${score(a)}`).join(' ')
	);
	dbg('pickTetherAddress picked:', candidates[0]);
	return candidates[0];
}

// --tailscale: advertise the tailnet address instead of the LAN pick. Detection
// is by Tailscale's CGNAT range (100.64.0.0/10): on macOS the interface is an
// anonymous utun*, so the address range is the only stable signal. No fallback —
// if Tailscale isn't up, say so and exit rather than quietly advertising a LAN
// URL the user didn't ask for.
function pickTailscaleAddress() {
	const addrs = tailscaleIPv4s();
	if (addrs.length === 0) {
		console.error('expediter: --tailscale was passed, but this Mac has no Tailscale address');
		console.error('(no IPv4 in 100.64.0.0/10 on any interface). Is Tailscale running and connected?');
		process.exit(1);
	}
	dbg('pickTailscaleAddress candidates:', addrs.join(' '));
	return addrs[0];
}

// --- check whether the daemon is already serving ---
async function isDaemonUp(scheme = transport) {
	try {
		const res = await fetch(`${scheme}://127.0.0.1:${PORT}/`, {
			signal: AbortSignal.timeout(750),
			tls: { rejectUnauthorized: false }
		});
		return res.status < 500;
	} catch {
		return false;
	}
}

// Detect an already-running daemon regardless of its transport, so re-running
// `expediter` reuses it and re-running with the other flag gives a clear
// "stop and restart to switch" message instead of an opaque port-in-use crash.
async function detectRunningScheme() {
	for (const scheme of ['https', 'http']) {
		if (await isDaemonUp(scheme)) return scheme;
	}
	return null;
}

async function waitForDaemon(timeoutMs = 15_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await isDaemonUp()) return true;
		await new Promise((r) => setTimeout(r, 250));
	}
	return false;
}

// --- fetch the in-memory token from the loopback-only endpoint ---
async function fetchToken() {
	let res;
	const tokenUrl = `${transport}://127.0.0.1:${PORT}/api/token`;
	try {
		res = await fetch(tokenUrl, {
			signal: AbortSignal.timeout(2000),
			tls: { rejectUnauthorized: false }
		});
	} catch (err) {
		throw new Error(
			`expediter: could not reach the daemon at ${tokenUrl} to read the session token. Is the daemon running? (${err.message})`
		);
	}
	if (res.status !== 200) {
		throw new Error(
			`expediter: /api/token returned HTTP ${res.status}. Expected 200. The daemon may be misconfigured.`
		);
	}
	return await res.text();
}

async function printAccess() {
	const addr = TAILSCALE_FLAG ? pickTailscaleAddress() : pickTetherAddress();

	// In https mode the leaf must cover the advertised IP or the phone gets a
	// bare TLS name-mismatch error. The daemon (re)issues the leaf only at
	// startup, so a daemon started before Tailscale came up won't cover the
	// tailnet address — tell the user to restart it rather than printing a QR
	// that cannot work. (A daemon this launcher just spawned always passes:
	// its leaf was issued moments ago with the tailnet address included.)
	if (TAILSCALE_FLAG && transport === 'https' && !leafCoversIp(addr)) {
		console.error(
			`expediter: the running daemon's certificate does not cover the Tailscale address ${addr}.`
		);
		console.error('Stop the daemon (Ctrl-C in its terminal), then re-run `expediter --tailscale` —');
		console.error('the fresh daemon reissues the certificate with the Tailscale address included.');
		process.exit(1);
	}

	if (!addr) {
		console.log('');
		console.log(`Daemon running at http://localhost:${PORT}/`);
		console.log('');
		console.log('No external network interface detected. Connect to Wi-Fi or plug your phone');
		console.log('in with USB Personal Hotspot, then re-run `expediter` to get the QR code.');
		return;
	}

	let token;
	try {
		token = await fetchToken();
	} catch (err) {
		console.error('');
		console.error(err.message);
		process.exit(1);
	}

	const url = accessUrl({ transport, lanIp: addr, appPort: PORT, token });
	if (!url) {
		console.error('expediter: no LAN address available to build the connection URL.');
		process.exit(1);
	}
	dbg('advertised URL (token redacted):', redactUrl(url));
	console.log('');
	console.log('  Scan the QR with your phone:');
	console.log('');
	qrcode.generate(url, { small: true });
	if (PRINT_URL) {
		console.log('');
		console.log(`  ${url}`);
		console.log('');
		console.log('  WARNING: the URL above contains the session token and will stay in');
		console.log('  your terminal scrollback. Restart the daemon to invalidate it.');
	}
	if (STEPS_RAW) {
		console.log('');
		const steps = STEPS_RAW.split('|');
		steps.forEach((step, i) => {
			console.log(`${i + 1}. ${step}`);
		});
	}
}

// --- main ---
// Resolve the transport first (sticky in config.json; default https) so every
// loopback probe and the spawn below speak the right scheme.
{
	let saved;
	try {
		const cfg = JSON.parse(await fs.readFile(CONFIG_FILE, 'utf8'));
		if (cfg && typeof cfg === 'object') saved = cfg.transport;
	} catch {
		// no config yet, or unreadable — fall through to the default
	}
	let persist = false;
	try {
		({ transport, persist } = resolveTransport({ httpFlag: HTTP_FLAG, httpsFlag: HTTPS_FLAG, saved }));
	} catch (err) {
		console.error(`expediter: ${err.message}`);
		process.exit(1);
	}
	if (persist) {
		let existing = {};
		try {
			const parsed = JSON.parse(await fs.readFile(CONFIG_FILE, 'utf8'));
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) existing = parsed;
		} catch {
			// fresh config
		}
		existing.transport = transport;
		await fs.mkdir(path.dirname(CONFIG_FILE), { recursive: true });
		await fs.writeFile(CONFIG_FILE, JSON.stringify(existing, null, 2) + '\n', 'utf8');
	}
}

dbg(`transport=${transport} port=${PORT} (loopback probe ${transport}://127.0.0.1:${PORT}/)`);

// Validate --tailscale before touching the daemon: with no tailnet address
// there is nothing useful to start or print, and failing later would leave a
// freshly spawned daemon running behind the error. Exits with the guidance
// message when no address is found; the picked value itself is re-derived in
// printAccess.
if (TAILSCALE_FLAG) pickTailscaleAddress();

const running = await detectRunningScheme();
if (running) {
	if (running !== transport) {
		console.error(
			`expediter: a daemon is already running over ${running.toUpperCase()} on port ${PORT}. ` +
				`Stop it (Ctrl-C in its terminal), then re-run \`expediter${transport === 'http' ? ' --http' : ''}\` to switch to ${transport.toUpperCase()}.`
		);
		process.exit(1);
	}
	dbg('daemon already running in the same mode — reusing it.');
	await printAccess();
	process.exit(0);
}
dbg('no daemon detected; starting a fresh one');

// Start the TLS-capable entry (bin/expediter-server.mjs) in the foreground,
// inheriting stdio so the user sees logs and Ctrl-C terminates it. NOT
// adapter-node's HTTP-only build/index.js: that entry hardcodes http and can't
// serve TLS. Transport is chosen by argv (--http) rather than an env var because
// adapter-node's build/env.js (envPrefix EXPEDITER_) throws at startup on any
// EXPEDITER_* var outside its closed allowlist (SOCKET_PATH, HOST, PORT, ORIGIN,
// XFF_DEPTH, ADDRESS_HEADER, PROTOCOL_HEADER, HOST_HEADER, PORT_HEADER,
// BODY_SIZE_LIMIT, SHUTDOWN_TIMEOUT, IDLE_TIMEOUT, KEEP_ALIVE_TIMEOUT,
// HEADERS_TIMEOUT), so EXPEDITER_TRANSPORT is impossible. We still pass the
// allowlisted EXPEDITER_PORT / EXPEDITER_HOST / EXPEDITER_SHUTDOWN_TIMEOUT;
// EXPEDITER_HOME is launcher-only, so strip it. EXPEDITER_SHUTDOWN_TIMEOUT is in
// seconds (adapter-node default 30); 1s keeps Ctrl-C responsive when a phone
// holds an SSE stream open. In https mode this entry also starts the
// cert-bootstrap doormat on port + 1.
const daemonEnv = {
	...process.env,
	EXPEDITER_PORT: PORT,
	EXPEDITER_HOST: '0.0.0.0',
	EXPEDITER_SHUTDOWN_TIMEOUT: '1'
};
delete daemonEnv.EXPEDITER_HOME;
const serverArgs = [`${HOME}/bin/expediter-server.mjs`];
if (transport === 'http') serverArgs.push('--http');
const child = spawn('bun', serverArgs, {
	stdio: ['ignore', 'inherit', 'inherit'],
	env: daemonEnv
});

child.on('exit', (code) => process.exit(code ?? 0));

// Ctrl-C handling: send SIGTERM, then SIGKILL after 500ms if the child
// hasn't exited. Bun's HTTP server (under adapter-node) doesn't actually
// release SSE response streams on server.closeAllConnections(), so the
// graceful path hangs whenever a phone has an open /api/stream. The 500ms
// silent escalation makes the user experience the same whether the phone
// is connected or not. A second Ctrl-C skips the wait entirely.
let killing = false;
function forwardSignal(sig) {
	if (killing) {
		child.kill('SIGKILL');
		process.exit(130);
	}
	killing = true;
	console.error('\nexpediter: shutting down...');
	child.kill(sig);
	setTimeout(() => {
		if (child.exitCode === null && child.signalCode === null) {
			child.kill('SIGKILL');
		}
	}, 500).unref();
}
process.on('SIGINT', () => forwardSignal('SIGTERM'));
process.on('SIGTERM', () => forwardSignal('SIGTERM'));

if (await waitForDaemon()) {
	await printAccess();
} else {
	console.error('expediter: daemon did not come up within 15s; check the logs above.');
}
