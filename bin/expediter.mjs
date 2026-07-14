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

// `expediter install remote <name>` / `expediter uninstall remote <name>` —
// remote-session setup (one marker-delimited ~/.ssh/config block per host, so
// machines are added and removed independently). Handled before anything else
// so it never starts the daemon, and it never opens an ssh connection itself:
// the Mac half writes local config and prints the command the user pastes on
// the box. `expediter install remote how` prints the plain-language steps.
if (process.argv[2] === 'install' || process.argv[2] === 'uninstall') {
	const action = process.argv[2];
	const name = process.argv[4];

	const HOW_TEXT = [
		'To link a remote machine:',
		'',
		'  1. On this Mac, run: expediter install remote <name>',
		'     <name> is what you type after `ssh` (e.g. devbox). This sets up the',
		'     connection path and prints the install command for step 2.',
		'',
		'  2. ssh into the remote machine as usual and paste that printed command.',
		'     It installs the mini-client in your home directory there.',
		'',
		'  3. That\'s it. From then on: ssh in, run claude -- tickets appear on your phone.',
		'',
		'To undo, run: expediter uninstall remote <name>',
		'The installation is per-machine -- to link more machines, repeat the steps',
		'above with each machine\'s host name.'
	].join('\n');

	if (process.argv[3] !== 'remote') {
		console.error('Usage: expediter install remote <name>     set up tickets for an ssh host');
		console.error('       expediter uninstall remote <name>   undo it for that host');
		console.error('       expediter install remote how        print the setup steps');
		process.exit(1);
	}
	if (action === 'install' && name === 'how') {
		console.log(HOW_TEXT);
		process.exit(0);
	}
	if (!name) {
		console.error(
			`expediter: ${action} remote needs the host name you normally type after \`ssh\`.`
		);
		console.error('Run `expediter install remote how` for the full steps.');
		process.exit(1);
	}
	// ssh `Host` patterns match the machine name only — a pattern containing
	// `user@` matches nothing, ever, and the tunnel silently never opens. So a
	// user@host name is rejected with the corrected command, not written.
	if (name.includes('@')) {
		const host = name.split('@').pop();
		console.error(
			`expediter: use just the machine name — ssh config can't match the "${name.split('@')[0]}@" part, so the tunnel would never open.`
		);
		console.error(`Run: expediter ${action} remote ${host}`);
		console.error('(Typing user@ when you ssh in is still fine — it only can\'t be in this name.)');
		process.exit(1);
	}
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
		console.error(
			`expediter: "${name}" does not look like an ssh host alias (letters, digits, . _ - only).`
		);
		process.exit(1);
	}

	// The pasted one-liner fetches install-remote.sh from the raw GitHub URL of
	// the branch this install runs — main for normal installs, the feature
	// branch during development — so the fetched installer (and the hook it
	// fetches in turn) match the daemon. `main` only when detection is
	// impossible (detached HEAD / not a git checkout).
	function detectBranch() {
		if (!HOME) return 'main';
		const r = spawnSync('git', ['-C', HOME, 'rev-parse', '--abbrev-ref', 'HEAD'], {
			encoding: 'utf8'
		});
		const b = r.status === 0 ? r.stdout.trim() : '';
		return b && b !== 'HEAD' ? b : 'main';
	}
	function pasteCommand({ uninstall = false } = {}) {
		const branch = detectBranch();
		const url = `https://raw.githubusercontent.com/AsteroidHunter/expediter/${branch}/install-remote.sh`;
		const args = [];
		if (uninstall) args.push('--uninstall');
		if (!uninstall && branch !== 'main') args.push('--branch', branch);
		return `curl -fsSL ${url} | bash${args.length ? ` -s -- ${args.join(' ')}` : ''}`;
	}

	const SSH_DIR = path.join(os.homedir(), '.ssh');
	const SSH_CONFIG_PATH = path.join(SSH_DIR, 'config');
	const BEGIN = `# >>> expediter remote-sessions: ${name} >>>`;
	const END = `# <<< expediter remote-sessions: ${name} <<<`;
	const stamp = () => {
		const d = new Date();
		const p = (n) => String(n).padStart(2, '0');
		return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
	};

	async function readConfigLines() {
		try {
			return (await fs.readFile(SSH_CONFIG_PATH, 'utf8')).split('\n');
		} catch {
			return null; // no config file yet
		}
	}
	async function backupConfig() {
		try {
			const raw = await fs.readFile(SSH_CONFIG_PATH, 'utf8');
			if (raw.trim()) {
				await fs.copyFile(SSH_CONFIG_PATH, `${SSH_CONFIG_PATH}.expediter-bak.${stamp()}`);
			}
		} catch {
			// nothing to back up
		}
	}
	// Drop trailing blank lines so appends stay tidy regardless of how the
	// file previously ended.
	function trimTail(lines) {
		while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
		return lines;
	}
	// Remove every block belonging to THIS host (stray duplicates collapse,
	// like install.sh's old rewrite did), plus the blank separator above each.
	// Other hosts' blocks — and everything else in the file — pass through.
	function spliceHostBlocks(lines) {
		const out = [];
		let removed = 0;
		let i = 0;
		while (i < lines.length) {
			if (lines[i].trim() === BEGIN) {
				let j = i + 1;
				while (j < lines.length && lines[j].trim() !== END) j++;
				removed++;
				i = j + 1;
				if (out.length && !out[out.length - 1].trim()) out.pop();
				continue;
			}
			out.push(lines[i]);
			i++;
		}
		return { out, removed };
	}

	if (action === 'install') {
		await fs.mkdir(SSH_DIR, { recursive: true, mode: 0o700 });
		await backupConfig();
		const existing = (await readConfigLines()) ?? [];
		const { out } = spliceHostBlocks(existing);
		trimTail(out);
		if (out.length) out.push('');
		out.push(BEGIN, `Host ${name}`, '  RemoteForward 5179 localhost:5179', END);
		await fs.writeFile(SSH_CONFIG_PATH, out.join('\n') + '\n', { mode: 0o600 });

		console.log('');
		console.log(`✓ Tunnel block written to ~/.ssh/config for "${name}".`);
		console.log('');
		console.log(`Next: ssh into ${name} as usual and paste this there, once:`);
		console.log('');
		console.log(`  ${pasteCommand()}`);
		console.log('');
		console.log(`After that: \`ssh ${name}\`, run claude, tickets appear on your phone.`);
		process.exit(0);
	}

	// action === 'uninstall'
	const lines = await readConfigLines();
	const { out, removed } = lines ? spliceHostBlocks(lines) : { out: null, removed: 0 };
	if (removed > 0) {
		await backupConfig();
		trimTail(out);
		// Never delete ~/.ssh/config itself, even when empty — nothing under
		// ~/.ssh gets deleted (same invariant as uninstall.sh).
		await fs.writeFile(SSH_CONFIG_PATH, out.length ? out.join('\n') + '\n' : '', {
			mode: 0o600
		});
		console.log('');
		console.log(`✓ Removed the "${name}" tunnel block from ~/.ssh/config.`);
	} else {
		console.log('');
		console.log(`⊘ No expediter block for "${name}" in ~/.ssh/config.`);
	}
	console.log('');
	console.log('To remove the mini-client from the box itself, run this there:');
	console.log('');
	console.log(`  ${pasteCommand({ uninstall: true })}`);
	process.exit(0);
}

// Any other bare word in the subcommand slot is a mistake. Error loudly
// instead of falling through to the daemon-start path — silently launching
// the daemon (and its QR) on a typo'd subcommand buries the user's actual
// error. Flags (-*) pass through untouched; `update`, `install`, and
// `uninstall` were dispatched above.
if (process.argv[2] && !process.argv[2].startsWith('-')) {
	const word = process.argv[2];
	console.error(`expediter: unknown command "${word}"`);
	if (word === 'remote' && (process.argv[3] === 'install' || process.argv[3] === 'uninstall')) {
		const rest = process.argv.slice(4).join(' ');
		console.error(`Did you mean: expediter ${process.argv[3]} remote ${rest || '<name>'}`);
	} else {
		console.error('Run `expediter --help` for usage.');
	}
	process.exit(1);
}

if (SHOW_HELP) {
	console.log(
		'Usage: expediter [--http|--https] [--tailscale] [--print-url] [--title default|haiku] [--steps "..."] [--help]'
	);
	console.log('   or: expediter update [--dev]');
	console.log('   or: expediter install remote <name> | uninstall remote <name> | install remote how');
	console.log('');
	console.log('  update                 Pull the latest and rebuild in place.');
	console.log('                         Add --dev (or --no-pull) to skip the pull and rebuild the');
	console.log('                         current checkout, e.g. when updating from a feature branch.');
	console.log('  install remote <name>  Set up tickets for claude sessions on an ssh host: writes');
	console.log('                         that host\'s tunnel block into ~/.ssh/config and prints the');
	console.log('                         command to paste on the box. `expediter install remote how`');
	console.log('                         prints the plain-language steps; `uninstall remote <name>`');
	console.log('                         undoes that host.');
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
