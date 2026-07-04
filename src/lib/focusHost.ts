import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

// Persistent JXA "focus host" — a single long-lived `osascript -l JavaScript`
// child that performs every Terminal raise, replacing the spawn-per-tap
// osascript of raiseTerminalScript's era. The win is NOT the ~25ms process
// spawn: a fresh osascript pays a cold Apple Event connection handshake to
// Terminal and System Events on every tell (~30-50ms per event), while a
// warm connection services the same event in ~5ms. Measured on the machine
// this was built for: ~450ms one-shot warm tap → ~25ms host round trip.
//
// Protocol: newline-delimited JSON requests on stdin, one reply line per
// request on stdout, strictly in order (the host is single-threaded).
//   {"tty":"/dev/ttys000","wid":22303,"ti":1} → "hit" | "miss:<wid>:<ti>" | "notfound"
//   {"tty":null}                              → "activated" (raise Terminal, no tab)
//   {"op":"warm"}                             → ";"-joined "wid|ti|tty" rows
// Reply tokens match parseActivateResult exactly, so the tty→tab cache logic
// in tmux.ts is unchanged. JSON carries the tty verbatim — the AppleScript
// string-escaping dance of the old inline script is gone entirely.
//
// No new permissions: the host sends the same Apple Events under the same
// Automation grant the one-shot osascript calls already used. Accessibility
// is not involved.
export const HELPER_SOURCE = `
ObjC.import('Foundation');
const stdin = $.NSFileHandle.fileHandleWithStandardInput;
const stdout = $.NSFileHandle.fileHandleWithStandardOutput;
const Terminal = Application('Terminal');
const SE = Application('System Events');

function writeLine(s) {
	stdout.writeData($(s + '\\n').dataUsingEncoding($.NSUTF8StringEncoding));
}

// Mirrors the invariants raiseTerminalScript accumulated one incident at a
// time — see tmux.ts history for the full story:
// - wasFront comes from System Events, NOT Terminal's own frontmost property,
//   which self-reports false while Terminal is the active app on a degraded
//   LaunchServices (and SE is also what the raise writes to).
// - The raise and the 200ms settle only run when Terminal ISN'T already
//   front: a raise issued in the first ~200ms after background→front
//   activation is dropped ~9/10 while the window stack settles, but an
//   already-front Terminal needs neither.
// - Never Terminal.activate() as the primary path: it blocks ~2s per call on
//   a degraded WindowServer/LaunchServices. It survives only as the recovery
//   when the System Events process lookup fails (Terminal not running —
//   activate also launches it).
// - The cached branch resolves the window by id in one Apple Event and
//   validates the tab's tty before trusting it; any failure falls through to
//   enumeration, which reads each window's ttys in ONE batched event
//   (tabs.tty()) instead of one event per tab.
// - Tab select via selected=true only — never window index reordering, which
//   makes Terminal re-evaluate its "primary" tab and snap focus elsewhere.
function raise(req) {
	let wasFront = false;
	try {
		const proc = SE.processes['Terminal'];
		wasFront = proc.frontmost();
		if (!wasFront) {
			proc.frontmost = true;
		}
	} catch (e) {
		Terminal.activate();
	}
	if (!req.tty) return 'activated';
	if (!wasFront) delay(0.2);
	if (req.wid != null) {
		try {
			const w = Terminal.windows.byId(req.wid);
			if (w.tabs[req.ti - 1].tty() === req.tty) {
				w.tabs[req.ti - 1].selected = true;
				w.frontmost = true;
				return 'hit';
			}
		} catch (e) {}
	}
	const wins = Terminal.windows();
	for (let wi = 0; wi < wins.length; wi++) {
		try {
			const w = wins[wi];
			const ttys = w.tabs.tty();
			for (let ti = 0; ti < ttys.length; ti++) {
				if (ttys[ti] === req.tty) {
					w.tabs[ti].selected = true;
					w.frontmost = true;
					return 'miss:' + w.id() + ':' + (ti + 1);
				}
			}
		} catch (e) {}
	}
	return 'notfound';
}

// One "wid|ti|tty" row per open Terminal tab, ';'-joined onto a single reply
// line (the protocol is line-oriented). Used at daemon boot to prime the
// tty→tab cache AND to warm this host's Apple Event connections so the first
// real tap doesn't pay the handshake.
function warm() {
	// Touch System Events too: the raise path needs BOTH connections warm, and
	// without this the first real tap still paid a ~250ms SE handshake.
	try {
		SE.processes['Terminal'].frontmost();
	} catch (e) {}
	const rows = [];
	const wins = Terminal.windows();
	for (let wi = 0; wi < wins.length; wi++) {
		try {
			const w = wins[wi];
			const wid = w.id();
			const ttys = w.tabs.tty();
			for (let ti = 0; ti < ttys.length; ti++) {
				rows.push(wid + '|' + (ti + 1) + '|' + ttys[ti]);
			}
		} catch (e) {}
	}
	return rows.join(';');
}

let buf = '';
while (true) {
	const data = stdin.availableData;
	if (data.length == 0) break;
	buf += $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding).js;
	let idx;
	while ((idx = buf.indexOf('\\n')) >= 0) {
		const line = buf.slice(0, idx);
		buf = buf.slice(idx + 1);
		if (!line.trim()) continue;
		let out;
		try {
			const req = JSON.parse(line);
			out = req.op === 'warm' ? warm() : raise(req);
		} catch (e) {
			out = 'error:' + ('' + e).slice(0, 120);
		}
		writeLine(out);
	}
}
`;

// A raise on a degraded machine can legitimately take ~2.5s (background
// Terminal + settle + enumeration); 10s means genuinely stuck — kill and
// let the next request respawn a fresh host.
const REQUEST_TIMEOUT_MS = 10_000;

type Pending = {
	resolve: (line: string) => void;
	reject: (err: Error) => void;
	timer: ReturnType<typeof setTimeout>;
};

type Host = ChildProcessByStdio<Writable, Readable, Readable>;

let host: Host | null = null;
// FIFO of in-flight requests. The host answers strictly in request order, so
// the head of the queue always owns the next reply line.
let pending: Pending[] = [];
let replyBuf = '';

const debugFocus = (msg: string): void => {
	if (process.env.DEBUG_FOCUS) console.log(msg);
};

function failAllPending(err: Error): void {
	const rejected = pending;
	pending = [];
	for (const p of rejected) {
		clearTimeout(p.timer);
		p.reject(err);
	}
}

function ensureHost(): Host {
	if (host) return host;
	replyBuf = '';
	const child = spawn('osascript', ['-l', 'JavaScript', '-e', HELPER_SOURCE], {
		stdio: ['pipe', 'pipe', 'pipe']
	});
	debugFocus(`[focus] host spawned pid=${child.pid}`);
	child.stdout.setEncoding('utf8');
	child.stdout.on('data', (chunk: string) => {
		replyBuf += chunk;
		let idx;
		while ((idx = replyBuf.indexOf('\n')) >= 0) {
			const line = replyBuf.slice(0, idx);
			replyBuf = replyBuf.slice(idx + 1);
			const p = pending.shift();
			if (p) {
				clearTimeout(p.timer);
				p.resolve(line);
			}
		}
	});
	child.stderr.setEncoding('utf8');
	child.stderr.on('data', (chunk: string) => {
		console.log(`[focus] host stderr=${chunk.trim().slice(0, 300)}`);
	});
	// 'close' (not 'exit') so the stdout buffer is fully drained before any
	// still-pending requests are failed. Whatever killed the host (crash,
	// logout, kill) — reject in-flight work loudly and let the next request
	// respawn.
	child.on('close', () => {
		debugFocus(`[focus] host exited pid=${child.pid}`);
		if (host === child) host = null;
		failAllPending(new Error('focus host exited'));
	});
	child.on('error', (err) => {
		if (host === child) host = null;
		failAllPending(err instanceof Error ? err : new Error(String(err)));
	});
	// Never keep the daemon alive just for the helper.
	child.unref();
	host = child;
	return child;
}

// Send one request line to the host and await its reply line. Rejects on
// host death, spawn failure, or timeout (which also kills the stuck host so
// the next call starts fresh). No retry here — callers decide what failure
// means; a dead host respawns on the next call.
function request(req: object): Promise<string> {
	const child = ensureHost();
	return new Promise<string>((resolve, reject) => {
		const timer = setTimeout(() => {
			const i = pending.findIndex((p) => p.timer === timer);
			if (i >= 0) pending.splice(i, 1);
			child.kill();
			reject(new Error(`focus host timed out after ${REQUEST_TIMEOUT_MS}ms`));
		}, REQUEST_TIMEOUT_MS);
		pending.push({ resolve, reject, timer });
		child.stdin.write(JSON.stringify(req) + '\n', (err) => {
			if (err) {
				const i = pending.findIndex((p) => p.timer === timer);
				if (i >= 0) pending.splice(i, 1);
				clearTimeout(timer);
				reject(err);
			}
		});
	});
}

// Raise the Terminal tab hosting `tty`, using the cached (windowId, tabIndex)
// when provided. Resolves to a parseActivateResult-compatible token. A null
// tty just brings Terminal forward (the no-attached-client fallback).
export function raiseTab(
	tty: string | null,
	cached: { windowId: number; tabIndex: number } | null
): Promise<string> {
	if (!tty) return request({ tty: null });
	if (cached) return request({ tty, wid: cached.windowId, ti: cached.tabIndex });
	return request({ tty });
}

// Enumerate every open Terminal tab as "wid|ti|tty" rows (newline-joined,
// ready for parseWarmCache). Spawning + serving this at boot also pre-warms
// the host's Apple Event connections for the first real tap.
export async function warmEnumerate(): Promise<string> {
	const reply = await request({ op: 'warm' });
	if (reply.startsWith('error:')) throw new Error(reply);
	return reply.split(';').join('\n');
}
