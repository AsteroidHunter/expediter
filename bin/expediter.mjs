#!/usr/bin/env bun
// expediter — start (or detect) the daemon, then print the tether URL + QR.
//
// Run from anywhere via the ~/.local/bin/expediter shim installed by install.sh.
// The shim sets EXPEDITER_HOME to the cloned-repo path, which is where this
// script, the SvelteKit build at $EXPEDITER_HOME/build/, and the daemon entry
// at $EXPEDITER_HOME/bin/expediter-server.mjs live.

import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import qrcode from 'qrcode-terminal';
import { localDotLocalName } from '../src/lib/server/cert.ts';
import { resolveTransport, accessUrl } from '../src/lib/server/transport.ts';

const PORT = process.env.EXPEDITER_PORT ?? '5179';
const HOME = process.env.EXPEDITER_HOME;
const PRINT_URL = process.argv.includes('--print-url');
const SHOW_HELP = process.argv.includes('--help') || process.argv.includes('-h');
const TITLE_IDX = process.argv.indexOf('--title');
const TITLE_VALUE = TITLE_IDX >= 0 ? process.argv[TITLE_IDX + 1] : null;
// --steps "<s1>|<s2>|..." — opt-in numbered-steps list appended below the QR.
// Used by `claudex uno` to print newbie-onboarding instructions. Plain
// `expediter` without --steps never prints steps. Steps are pipe-delimited;
// each step renders on its own line prefixed with "<n>. " (1-indexed).
const STEPS_IDX = process.argv.indexOf('--steps');
const STEPS_RAW = STEPS_IDX !== -1 ? process.argv[STEPS_IDX + 1] : undefined;
// Transport selection. HTTPS is the default; --http opts out to cert-free
// plaintext (for a phone that can't/won't trust the local CA, or a network that
// blocks .local/mDNS). Either flag is sticky: it's written to config.json so it
// survives the next plain `expediter`, mirroring --title.
const HTTP_FLAG = process.argv.includes('--http');
const HTTPS_FLAG = process.argv.includes('--https');

const CONFIG_DIR = path.join(os.homedir(), '.expediter');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

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

async function readConfig() {
	try {
		const parsed = JSON.parse(await fs.readFile(CONFIG_FILE, 'utf8'));
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
	} catch {
		// missing or malformed — treat as empty
	}
	return {};
}

async function writeConfig(patch) {
	const next = { ...(await readConfig()), ...patch };
	await fs.mkdir(CONFIG_DIR, { recursive: true });
	await fs.writeFile(CONFIG_FILE, JSON.stringify(next, null, 2) + '\n', 'utf8');
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
		'Usage: expediter [--http|--https] [--print-url] [--title default|haiku] [--steps "<s1>|<s2>|..."] [--help]'
	);
	console.log('   or: expediter update [--dev]');
	console.log('');
	console.log('  update                 Pull the latest and rebuild in place.');
	console.log('                         Add --dev (or --no-pull) to skip the pull and rebuild the');
	console.log('                         current checkout, e.g. when updating from a feature branch.');
	console.log('  --print-url            Also print the tethered URL as text (default: QR only).');
	console.log('                         Use this only if your phone cannot scan the QR — the URL');
	console.log('                         contains the session token and will stay in scrollback.');
	console.log('  --https                Serve over HTTPS (the default). Needs a one-time');
	console.log('                         certificate trust on the phone; enables PWA install.');
	console.log('  --http                 Serve plaintext instead; no certificate needed. Both');
	console.log('                         flags are sticky (saved to ~/.expediter/config.json).');
	console.log('  --title default|haiku  Set the ticket title source and exit.');
	console.log('                         "default" uses the Claude chat title (auto-titled or via');
	console.log('                         /rename), with a whimsical name as fallback. "haiku" uses');
	console.log('                         the LLM-generated caveman summary. Writes to');
	console.log('                         ~/.expediter/config.json.');
	console.log('  --steps                Pipe-delimited list of numbered steps to print below the QR.');
	console.log('                         Opt-in; used by `claudex uno` for newbie-onboarding.');
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
	await writeConfig({ title_source: internal });
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

// Resolve the transport before anything probes or starts the daemon. An
// explicit flag wins and is persisted; otherwise use the saved preference,
// defaulting to HTTPS. (Logic lives in src/lib/server/transport.ts so it's
// unit-tested.)
let transport;
try {
	const resolved = resolveTransport({
		httpFlag: HTTP_FLAG,
		httpsFlag: HTTPS_FLAG,
		saved: (await readConfig()).transport
	});
	transport = resolved.transport;
	if (resolved.persist) await writeConfig({ transport });
} catch (err) {
	console.error(`expediter: ${err.message}`);
	process.exit(1);
}
const SCHEME = transport;

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

function pickTetherAddress() {
	const ifaces = os.networkInterfaces();
	const candidates = [];
	for (const addrs of Object.values(ifaces)) {
		if (!addrs) continue;
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

// --- check whether the daemon is already serving ---
async function isDaemonUp() {
	try {
		const res = await fetch(`${SCHEME}://127.0.0.1:${PORT}/`, {
			signal: AbortSignal.timeout(750),
			// Loopback to our own self-signed cert: skip verification. Safe because
			// the connection can't leave the machine, so there's nothing to MITM.
			// Bun's native fetch honors this `tls` option.
			...(SCHEME === 'https' ? { tls: { rejectUnauthorized: false } } : {})
		});
		return res.status < 500;
	} catch {
		return false;
	}
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
	const tokenUrl = `${SCHEME}://127.0.0.1:${PORT}/api/token`;
	let res;
	try {
		res = await fetch(tokenUrl, {
			signal: AbortSignal.timeout(2000),
			...(SCHEME === 'https' ? { tls: { rejectUnauthorized: false } } : {})
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
	let token;
	try {
		token = await fetchToken();
	} catch (err) {
		console.error('');
		console.error(err.message);
		process.exit(1);
	}

	// HTTPS → https://<host>.local (the cert SAN, stable across DHCP); HTTP → the
	// raw LAN IP. accessUrl returns null only for HTTP with no LAN interface.
	const dotLocalHost = transport === 'https' ? localDotLocalName() : '';
	const lanIp = transport === 'http' ? pickTetherAddress() : null;
	dbg(
		`building access URL: transport=${transport} dotLocalHost=${dotLocalHost || '<n/a>'} lanIp=${lanIp || '<n/a>'} port=${PORT}`
	);
	if (transport === 'https') {
		dbg(
			`the phone must resolve "${dotLocalHost}" via mDNS/Bonjour AND trust the CA at ~/.expediter/tls/ca.crt`
		);
	}
	const url = accessUrl({
		transport,
		dotLocalHost,
		lanIp,
		port: PORT,
		token
	});
	dbg('advertised URL (token redacted):', redactUrl(url) ?? '<none>');
	if (!url) {
		console.log('');
		console.log(`Daemon running at http://localhost:${PORT}/`);
		console.log('');
		console.log('No external network interface detected. Connect to Wi-Fi or plug your phone');
		console.log('in with USB Personal Hotspot, then re-run `expediter` to get the QR code.');
		return;
	}

	console.log('');
	console.log('  Scan the QR with your phone:');
	console.log('');
	qrcode.generate(url, { small: true });
	if (transport === 'https') {
		console.log('');
		console.log('  First time on this phone? Install the certificate so it trusts the');
		console.log('  connection: AirDrop ~/.expediter/tls/ca.crt to the phone, open it,');
		console.log('  install the profile, then turn it on under Settings > General > About');
		console.log('  > Certificate Trust Settings. Prefer plaintext? Run `expediter --http`.');
	}
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
dbg(`transport=${transport} port=${PORT} (loopback probe ${SCHEME}://127.0.0.1:${PORT}/)`);
if (await isDaemonUp()) {
	dbg(
		'daemon already running — reusing it. Gate debug logging only appears if THAT process was started with DEBUG_EXPEDITER. Stop it (Ctrl-C in its terminal) and re-run to capture gate logs.'
	);
	await printAccess();
	process.exit(0);
}
dbg('no daemon detected; starting a fresh one with current env');

// Start the daemon in the foreground. Inherit stdio so the user sees its logs
// and Ctrl-C terminates it cleanly. bin/expediter-server.mjs is our TLS-capable
// entry: it reuses adapter-node's build/handler.js but picks the socket
// (https.createServer by default, http with --http) since the generated
// build/index.js is HTTP-only.
//
// svelte.config.js sets `envPrefix: 'EXPEDITER_'`, so adapter-node reads
// EXPEDITER_PORT / EXPEDITER_HOST (not PORT / HOST). Pass the prefixed names.
// adapter-node's build/env.js validates EXPEDITER_* env vars strictly against a
// closed allowlist (SOCKET_PATH, HOST, PORT, ORIGIN, XFF_DEPTH,
// ADDRESS_HEADER, PROTOCOL_HEADER, HOST_HEADER, PORT_HEADER, BODY_SIZE_LIMIT,
// SHUTDOWN_TIMEOUT, IDLE_TIMEOUT, KEEP_ALIVE_TIMEOUT, HEADERS_TIMEOUT) and
// throws at startup for anything else. EXPEDITER_HOME is launcher-only — the
// daemon doesn't need it — so strip it (and any other future launcher-only
// EXPEDITER_* var) before spawning.
// EXPEDITER_SHUTDOWN_TIMEOUT is in seconds (adapter-node default: 30). The
// default tries to drain SSE connections cleanly, which makes Ctrl-C feel
// unresponsive when a phone has an open stream. 1s is the lowest non-zero
// value and is plenty for our (single-user) daemon.
const daemonEnv = {
	...process.env,
	EXPEDITER_PORT: PORT,
	EXPEDITER_HOST: '0.0.0.0',
	EXPEDITER_SHUTDOWN_TIMEOUT: '1'
};
delete daemonEnv.EXPEDITER_HOME;
console.log('Starting Expediter daemon...');
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
