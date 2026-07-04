import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { raiseTab, warmEnumerate } from './focusHost';

const execFileAsync = promisify(execFile);

export class FocusError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'FocusError';
	}
}

// Gated on DEBUG_FOCUS so happy-path focus logs only run when diagnosing
// tap-to-focus locally. Error-path console.log calls below stay unconditional
// so failed taps are always visible.
const debugFocus = (msg: string): void => {
	if (process.env.DEBUG_FOCUS) console.log(msg);
};

// Diagnostic: capture Terminal/macOS state. Used before and after the focus
// AppleScript so we can spot taps where the script "succeeded" but nothing
// actually moved. Returns a short string like "Terminal/dev/ttys020"
// (frontmost-app/selected-tab-tty-of-frontmost-window). Never throws.
async function captureTerminalState(): Promise<string> {
	const script = `
tell application "System Events" to set fa to name of first application process whose frontmost is true
set wTty to "none"
tell application "Terminal"
	try
		set wTty to tty of (first tab of window 1 whose selected is true)
	end try
end tell
return fa & "|" & wTty`;
	try {
		const { stdout } = await execFileAsync('osascript', ['-e', script]);
		return stdout.trim();
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return `err:${msg.slice(0, 80)}`;
	}
}

// Parses `tmux list-clients -F '#{client_activity} #{client_tty}'` output and
// returns the most-recently-active client's tty. Multi-client sessions emit one
// row per attached client; picking by activity raises the terminal the user
// actually just touched, not whichever client tmux happened to list first.
// Malformed rows (no space, non-numeric activity, empty tty) are silently
// skipped. Returns null when no usable row remains.
export function pickMostRecentTty(stdout: string): string | null {
	const rows = stdout
		.split('\n')
		.map((s) => s.trim())
		.filter((s) => s.length > 0)
		.map((line) => {
			const sp = line.indexOf(' ');
			if (sp < 0) return null;
			const activity = Number(line.slice(0, sp));
			const tty = line.slice(sp + 1).trim();
			if (!Number.isFinite(activity) || !tty) return null;
			return { activity, tty };
		})
		.filter((r): r is { activity: number; tty: string } => r !== null);
	if (rows.length === 0) return null;
	rows.sort((a, b) => b.activity - a.activity);
	return rows[0].tty;
}

// Parses `tmux list-clients -F '#{client_activity}|#{client_tty}|#{window_id}'`
// (no -t filter, so one row per attached client across ALL sessions) and returns
// the most-recently-active client whose currently-displayed window is
// `windowId`. This is what disambiguates a session group: a window shared across
// grouped sessions is on screen only in the client(s) that have it as their
// current window, so matching on the displayed window — not the owning session —
// finds the tab the user is actually looking at. Genuinely mirrored clients
// (two clients on one session showing the same window) both match and break by
// activity, like pickMostRecentTty. Returns null when no attached client
// currently displays the window. Malformed rows (fewer than 3 columns,
// non-numeric activity, empty tty/window) are silently skipped.
export function pickTtyForWindow(stdout: string, windowId: string): string | null {
	if (!windowId) return null;
	const rows = stdout
		.split('\n')
		.map((s) => s.trim())
		.filter((s) => s.length > 0)
		.map((line) => {
			const parts = line.split('|');
			if (parts.length < 3) return null;
			const activity = Number(parts[0]);
			const tty = parts[1].trim();
			const win = parts[2].trim();
			if (!Number.isFinite(activity) || !tty || !win) return null;
			return { activity, tty, win };
		})
		.filter((r): r is { activity: number; tty: string; win: string } => r !== null)
		.filter((r) => r.win === windowId);
	if (rows.length === 0) return null;
	rows.sort((a, b) => b.activity - a.activity);
	return rows[0].tty;
}

async function clientTtyForSession(session: string): Promise<string | null> {
	try {
		const { stdout } = await execFileAsync('tmux', [
			'list-clients',
			'-t',
			session,
			'-F',
			'#{client_activity} #{client_tty}'
		]);
		return pickMostRecentTty(stdout);
	} catch {
		return null;
	}
}

export type TabLocation = { windowId: number; tabIndex: number };

export type ActivateResult =
	| { kind: 'hit' }
	| { kind: 'miss'; windowId: number; tabIndex: number }
	| { kind: 'notfound' }
	| { kind: 'unknown'; raw: string };

// tty → (windowId, tabIndex) lookup populated on first focus for a given tty
// and validated each subsequent call by `tty of tab T of window id W`. Stale
// entries (tab moved or window closed) silently fall through to the enumeration
// branch, which rebuilds the cache. Lives at module scope so it persists across
// requests within the SvelteKit server process.
const ttyToTab = new Map<string, TabLocation>();

export function parseActivateResult(stdout: string): ActivateResult {
	const trimmed = stdout.trim();
	if (trimmed === 'hit') return { kind: 'hit' };
	if (trimmed === 'notfound') return { kind: 'notfound' };
	if (trimmed.startsWith('miss:')) {
		const parts = trimmed.split(':');
		const wid = Number(parts[1]);
		const tix = Number(parts[2]);
		if (Number.isFinite(wid) && Number.isFinite(tix)) {
			return { kind: 'miss', windowId: wid, tabIndex: tix };
		}
	}
	return { kind: 'unknown', raw: trimmed };
}

export function applyActivateResult(
	cache: Map<string, TabLocation>,
	tty: string,
	result: ActivateResult
): void {
	if (result.kind === 'miss') {
		cache.set(tty, { windowId: result.windowId, tabIndex: result.tabIndex });
	} else if (result.kind === 'notfound') {
		cache.delete(tty);
	}
	// 'hit' confirms the cached entry is still valid; 'unknown' leaves the
	// cache untouched so a stale entry isn't blown away by a malformed response.
}

// Parses the warm-cache enumeration output — one "windowId|tabIndex|tty" row
// per Terminal tab — into cache entries. Malformed rows (missing columns,
// non-numeric ids, empty tty) are silently skipped, matching the other parsers
// here. Pure for unit-testing.
export function parseWarmCache(stdout: string): Map<string, TabLocation> {
	const entries = new Map<string, TabLocation>();
	for (const line of stdout.split('\n')) {
		const parts = line.trim().split('|');
		if (parts.length !== 3) continue;
		const windowId = Number(parts[0]);
		const tabIndex = Number(parts[1]);
		const tty = parts[2].trim();
		if (!Number.isFinite(windowId) || !Number.isFinite(tabIndex) || !tty) continue;
		entries.set(tty, { windowId, tabIndex });
	}
	return entries;
}

// Pre-populate ttyToTab with every (tty → window id, tab index) currently open
// in Terminal. Called fire-and-forget at daemon boot (hooks.server.ts): the
// module-scope cache is empty exactly then, so without this the first tap on
// every session after a restart pays the per-window enumeration in the focus
// host. Going through the host also spawns it and warms its Apple Event
// connections at boot, so the first real tap skips the ~150ms cold handshake
// too. Entries that go stale later (tab moved, window closed) are already
// handled by the host's tty-validation + enumeration fallback. Never throws —
// on a Mac without Terminal running, or a non-macOS dev box, the cache just
// stays cold.
export async function warmFocusCache(): Promise<void> {
	try {
		const rows = await warmEnumerate();
		for (const [tty, loc] of parseWarmCache(rows)) {
			ttyToTab.set(tty, loc);
		}
		debugFocus(`[focus] warm cache primed: ${ttyToTab.size} ttys`);
	} catch {
		// Terminal not running / no osascript — first taps fall back to enumeration.
	}
}

// The Terminal raise itself — cache-hit resolve, enumeration fallback,
// wasFront gating, settle delay — lives in the persistent focus host
// (focusHost.ts), which replaced the spawn-per-tap osascript scripts. The
// host's HELPER_SOURCE carries the full invariant history in its comments.

export async function focusPane(pane: string): Promise<void> {
	if (!pane || !/^%[0-9]+$/.test(pane)) {
		throw new FocusError(`invalid pane id '${pane}'`);
	}

	let windowId: string;
	let session: string;
	let clientRows: string;
	try {
		// ONE tmux spawn resolves the pane AND lists the attached clients:
		// display-message prints its single line first, then list-clients appends
		// one row per client. Chained via ';' (like select-window/select-pane
		// below) — each tmux spawn costs ~25ms, so folding the second query into
		// the first takes it off every tap's critical path.
		const { stdout } = await execFileAsync('tmux', [
			'display-message',
			'-p',
			'-t',
			pane,
			'#{window_id}|#{session_name}',
			';',
			'list-clients',
			'-F',
			'#{client_activity}|#{client_tty}|#{window_id}'
		]);
		const nl = stdout.indexOf('\n');
		const first = nl >= 0 ? stdout.slice(0, nl) : stdout;
		clientRows = nl >= 0 ? stdout.slice(nl + 1) : '';
		// window_id (`@N`) never contains a pipe, so split on the first one;
		// the remainder is the session name.
		const sep = first.indexOf('|');
		windowId = sep >= 0 ? first.slice(0, sep).trim() : '';
		session = (sep >= 0 ? first.slice(sep + 1) : first).trim();
	} catch {
		throw new FocusError(`pane '${pane}' no longer exists`);
	}

	if (!session) {
		throw new FocusError(`pane '${pane}' resolved to empty session`);
	}

	// Resolve the target Terminal tty BEFORE switching windows. A pane's window
	// can be shared across a session group — grouped sessions each have their own
	// client with an independent current window — so the client currently
	// displaying this window is the tab the user is actually looking at. The
	// select-window below switches every client on the session to this window,
	// which would erase that distinction, so we capture it first. Falls back to
	// the session's most-recently-active client when no attached client currently
	// has this window on screen (e.g. the user navigated away in every tab).
	let tty = windowId ? pickTtyForWindow(clientRows, windowId) : null;
	if (!tty) tty = await clientTtyForSession(session);
	debugFocus(`[focus] pane=${pane} window=${windowId} session=${session} tty=${tty ?? '<none>'}`);

	// select-window switches the session's current window to the one containing
	// the pane; select-pane then picks the exact pane within that window. Both
	// are needed: select-pane alone doesn't change the active window (so taps
	// across windows wouldn't switch), and select-window alone falls back to
	// whichever pane was last active (wrong when two Claude panes share a
	// window). Chained in one tmux invocation via ';' to avoid a second process
	// spawn. It runs CONCURRENTLY with the osascript raise below: the two act on
	// different layers (tmux content inside the client vs Terminal window
	// z-order) and neither reads state the other writes — the tty was already
	// resolved above — so overlapping them takes the ~30ms tmux call off the
	// critical path. The failure is captured (not thrown) so the raise's own
	// error handling stays intact, and re-checked after the raise.
	const selectFailure = execFileAsync('tmux', [
		'select-window',
		'-t',
		pane,
		';',
		'select-pane',
		'-t',
		pane
	]).then(
		() => null,
		() => new FocusError(`tmux select-window/select-pane failed for '${pane}'`)
	);

	// const pre = await captureTerminalState();
	// console.log(`[focus] state pre=${pre}`);

	const cached = tty ? ttyToTab.get(tty) ?? null : null;
	const tRaise = Date.now();
	let so: string;
	try {
		so = (await raiseTab(tty, cached)).trim();
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.log(`[focus] focus host threw: ${msg}`);
		throw new FocusError('Terminal raise failed');
	}
	// 'error:' is the host's in-band failure token (its handler threw — e.g.
	// Terminal quit mid-request). Loud like the throw above, not a silent miss.
	if (so.startsWith('error:')) {
		console.log(`[focus] focus host ${so}`);
		throw new FocusError('Terminal raise failed');
	}
	if (tty) {
		const result = parseActivateResult(so);
		applyActivateResult(ttyToTab, tty, result);
		debugFocus(
			`[focus] activate tty=${tty} result=${so || '<empty>'} cached=${cached ? 'y' : 'n'} osa=${Date.now() - tRaise}ms`
		);
	}

	const selectErr = await selectFailure;
	if (selectErr) throw selectErr;

	// const post = await captureTerminalState();
	// const moved = pre !== post;
	// console.log(`[focus] state post=${post} moved=${moved} wanted_tty=${tty ?? '<none>'}`);
}

// Re-attach a detached session by opening a NEW Terminal window running
// `tmux attach -t <session>`, raised to the front. This is deliberately NOT a
// reuse of focusPane's machinery: focusPane finds an existing client's tty and
// raises that tab, but a detached session has no client and no tab to raise —
// the whole point is that nothing is showing it. So we share only the pane→
// session resolve and otherwise just spawn a fresh window via AppleScript
// `do script` (no `in` clause → new window) + `activate`. The next reconcile
// (the client-attached tmux hook fires as the new client attaches) flips the
// card to Attached and it migrates pages on its own. Throws FocusError (→ 410
// at the route) when the pane/session is gone, mirroring focusPane.
export async function attachSession(pane: string): Promise<void> {
	if (!pane || !/^%[0-9]+$/.test(pane)) {
		throw new FocusError(`invalid pane id '${pane}'`);
	}

	let session: string;
	try {
		const { stdout } = await execFileAsync('tmux', [
			'display-message',
			'-p',
			'-t',
			pane,
			'#{session_name}'
		]);
		session = stdout.trim();
	} catch {
		throw new FocusError(`pane '${pane}' no longer exists`);
	}

	if (!session) {
		throw new FocusError(`pane '${pane}' resolved to empty session`);
	}

	// Escape for embedding in the AppleScript string literal, then wrap the
	// session in shell quotes inside the command so a name with spaces still
	// resolves. `do script` runs the command in a new Terminal window (and
	// launches Terminal if it isn't running). The raise goes through System
	// Events `set frontmost of process` for the same reason as
	// raiseTerminalScript: AppleScript `activate` blocks ~2s per call on a
	// degraded WindowServer/LaunchServices, and this machine pays that cost
	// chronically. `activate` survives only as the on-error fallback for when
	// the process can't be addressed yet.
	const escapedSession = session.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
	const script = `tell application "Terminal"
	do script "tmux attach -t \\"${escapedSession}\\""
end tell
try
	tell application "System Events" to set frontmost of process "Terminal" to true
on error
	tell application "Terminal" to activate
end try`;

	try {
		await execFileAsync('osascript', ['-e', script]);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.log(`[attach] osascript threw: ${msg}`);
		throw new FocusError('osascript Terminal.app attach failed');
	}
}

// Detach a session from the phone: resolve the pane to its session, then
// `tmux detach-client -s <session>` (drops ALL clients of that session, matching
// the whole-session model of attach). No Terminal/osascript — detach is pure
// tmux. Throws FocusError (→ 410) when the pane/session is already gone. The
// detach-client call itself is best-effort: it can exit non-zero when the
// session has no attached client (already detached), which is the desired end
// state anyway, so we swallow that — the next reconcile reflects the truth and
// moves the card to the Detached page.
export async function detachSession(pane: string): Promise<void> {
	if (!pane || !/^%[0-9]+$/.test(pane)) {
		throw new FocusError(`invalid pane id '${pane}'`);
	}

	let session: string;
	try {
		const { stdout } = await execFileAsync('tmux', [
			'display-message',
			'-p',
			'-t',
			pane,
			'#{session_name}'
		]);
		session = stdout.trim();
	} catch {
		throw new FocusError(`pane '${pane}' no longer exists`);
	}

	if (!session) {
		throw new FocusError(`pane '${pane}' resolved to empty session`);
	}

	try {
		await execFileAsync('tmux', ['detach-client', '-s', session]);
	} catch (err) {
		// Non-zero usually means "no client attached to that session" — already in
		// the desired (detached) state. Log under DEBUG_FOCUS and treat as success.
		debugFocus(`[detach] detach-client -s ${session} non-zero (already detached?): ${err}`);
	}
}

// ─── Pane input injection (send-keys / paste) ───────────────────────────────
//
// The daemon historically only *queried* and *raised* panes; this block adds the
// single seam both speech-to-prompt backends share — writing into a pane's input.
// Baseten produces the transcript remotely and submitPrompt() types it in; the
// built-in /voice backend has Claude Code produce the text locally and the daemon
// only drives start/stop with sendKeys(['Space']). Every inject endpoint gates on
// paneAcceptsInput() first (tier-1 readiness).

export class InjectError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'InjectError';
	}
}

// tmux pane ids are always `%` followed by digits. Same guard focusPane /
// attachSession apply inline; injection adds a couple more call sites, so it
// earns a name here. Keeps a malformed/attacker-supplied id from reaching tmux.
function isValidPane(pane: string): boolean {
	return /^%[0-9]+$/.test(pane);
}

// execFile variant that writes `input` to the child's stdin then closes it.
// promisify(execFile) exposes no stdin handle, and `tmux load-buffer -` reads the
// buffer body from stdin — so this small wrapper bridges the two. Used instead of
// passing the transcript as an argv element (set-buffer) to dodge ARG_MAX on long
// dictations and the leading-dash flag ambiguity of arbitrary text.
function execFileWithInput(
	file: string,
	args: string[],
	input: string
): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = execFile(file, args, (err, stdout, stderr) => {
			if (err) reject(err);
			else resolve({ stdout: String(stdout), stderr: String(stderr) });
		});
		const stdin = child.stdin;
		if (!stdin) {
			reject(new Error('child process has no stdin'));
			return;
		}
		stdin.on('error', reject);
		stdin.end(input);
	});
}

// Build the argv for `tmux send-keys` sending named keys/chords (e.g. 'Space',
// 'Enter', 'C-u', 'Escape') to a pane. NOT for literal transcript text: tmux
// looks each argument up in its key table, so a word like "Enter" in a transcript
// would be sent as the Enter key. Use submitPrompt() for text. Pure so the
// command shape is unit-testable, mirroring raiseTerminalScript.
export function sendKeysArgs(pane: string, keys: string[]): string[] {
	return ['send-keys', '-t', pane, ...keys];
}

// Send one or more named keys/chords to a pane: Space to drive /voice tap,
// C-u to clear the prompt, Escape to dismiss, Enter to submit. Throws InjectError
// on a bad pane id or a tmux failure (e.g. pane gone).
export async function sendKeys(pane: string, keys: string[]): Promise<void> {
	if (!isValidPane(pane)) throw new InjectError(`invalid pane id '${pane}'`);
	if (keys.length === 0) throw new InjectError('sendKeys requires at least one key');
	try {
		await execFileAsync('tmux', sendKeysArgs(pane, keys));
	} catch {
		throw new InjectError(`tmux send-keys failed for pane '${pane}'`);
	}
}

// Build the argv to drop a pane OUT of copy/view mode. tmux dispatches send-keys to
// the copy-mode key table while a pane is in mode, so injected keys (a /voice
// Space, a C-u) would drive the scrollback viewer instead of Claude Code; `-X
// cancel` is the copy-mode command that leaves the mode and returns the pane to the
// live prompt. Only valid while the pane is in a mode (tmux is a no-op otherwise) —
// callers gate on a copy-mode readiness verdict. Pure for unit-testing the shape.
export function exitCopyModeArgs(pane: string): string[] {
	return ['send-keys', '-t', pane, '-X', 'cancel'];
}

// Leave copy/view mode on a pane so a following inject reaches Claude Code. Side
// effect: the pane's view snaps back to the live prompt — you can't type into
// Claude while scrolled up reading history. Throws InjectError on a bad pane id or
// a tmux failure.
export async function exitCopyMode(pane: string): Promise<void> {
	if (!isValidPane(pane)) throw new InjectError(`invalid pane id '${pane}'`);
	try {
		await execFileAsync('tmux', exitCopyModeArgs(pane));
	} catch {
		throw new InjectError(`tmux exit copy-mode failed for pane '${pane}'`);
	}
}

// Build the argv for `tmux send-keys -l` sending LITERAL text (no key-name lookup)
// to a pane — used to live-type Baseten transcript suffixes as they stream in.
// `--` terminates flag parsing so a suffix starting with '-' isn't read as a flag.
// Pure for unit-testing the command shape.
export function sendTextArgs(pane: string, text: string): string[] {
	return ['send-keys', '-t', pane, '-l', '--', text];
}

// Type literal text into a pane (no Enter) for incremental live transcription.
// Empty text is a no-op. Throws InjectError on a bad pane id or tmux failure.
export async function sendText(pane: string, text: string): Promise<void> {
	if (!isValidPane(pane)) throw new InjectError(`invalid pane id '${pane}'`);
	if (text.length === 0) return;
	try {
		await execFileAsync('tmux', sendTextArgs(pane, text));
	} catch {
		throw new InjectError(`tmux send-keys -l failed for pane '${pane}'`);
	}
}

// The dedicated tmux paste buffer the daemon loads transcript text into. Named
// (not the anonymous default stack) so injecting never disturbs whatever the user
// keeps in their own paste buffers; paste-buffer -d deletes it right after use.
const INJECT_BUFFER = 'expediter-voice';

// Build the `tmux paste-buffer` argv for the inject buffer:
//   -d  delete the buffer after pasting (no accumulation, no pollution)
//   -p  bracketed paste, so multi-line / special text lands as literal input
//       instead of submitting early or being interpreted as keys
//   -r  no LF→CR translation, so newlines stay newlines inside the paste
// Pure for unit-testing the command shape.
export function pasteBufferArgs(pane: string): string[] {
	return ['paste-buffer', '-d', '-p', '-r', '-b', INJECT_BUFFER, '-t', pane];
}

// Inject transcript `text` into a pane's prompt and submit it with Enter.
// load-buffer (stdin) + paste-buffer rather than `send-keys <text>` so the
// transcript is taken verbatim — send-keys would interpret tokens like "Enter"
// as key names and mangle multi-line text. Callers guard empty/too-short text
// (the 3-word minimum) before calling; this is mechanical. Throws InjectError on
// a bad pane id or tmux failure.
export async function submitPrompt(pane: string, text: string): Promise<void> {
	if (!isValidPane(pane)) throw new InjectError(`invalid pane id '${pane}'`);
	try {
		await execFileWithInput('tmux', ['load-buffer', '-b', INJECT_BUFFER, '-'], text);
		await execFileAsync('tmux', pasteBufferArgs(pane));
		await execFileAsync('tmux', sendKeysArgs(pane, ['Enter']));
	} catch {
		throw new InjectError(`tmux paste/submit failed for pane '${pane}'`);
	}
}

// Command names tmux reports in `#{pane_current_command}` when Claude Code is the
// pane's foreground process. The native installer's binary surfaces as
// `claude.exe` (verified on this machine, tmux 3.6a, by listing live panes);
// `claude` covers other install paths. Deliberately specific — `node`/`bun` are
// too broad and would defeat the guard.
const CLAUDE_PANE_COMMANDS = ['claude.exe', 'claude'];

// Why a pane isn't ready for injection. `copy-mode` is the one reason a caller can
// recover from (it's the user's scroll position, not a hard blocker) — every other
// reason means the pane genuinely can't take Claude input right now. See
// ensurePaneInputReady, which keys off this.
export type PaneNotReadyReason = 'invalid-pane' | 'gone' | 'not-claude' | 'copy-mode' | 'unreadable';
export type PaneReadiness =
	| { ready: true }
	| { ready: false; reason: string; code: PaneNotReadyReason };

// Parse `display-message -p '#{pane_current_command}|#{pane_in_mode}'` output into
// a tier-1 readiness verdict: the foreground process must be Claude Code and the
// pane must not be in copy/view mode. Coarse by design — it does NOT read the
// screen, so it can't catch a permission dialog or a mid-turn prompt (tier 2,
// deferred; a blind inject onto a dialog is a known residual risk). Pure for
// unit-testing, mirroring parseActivateResult.
export function parsePaneReadiness(
	stdout: string,
	claudeCommands: string[] = CLAUDE_PANE_COMMANDS
): PaneReadiness {
	const trimmed = stdout.trim();
	const sep = trimmed.indexOf('|');
	// Fail closed: our format string always joins both fields with a literal '|',
	// so a missing separator means malformed output — refuse rather than guess.
	if (sep < 0) return { ready: false, reason: 'could not read pane state', code: 'unreadable' };
	const cmd = trimmed.slice(0, sep).trim();
	const inMode = trimmed.slice(sep + 1).trim();
	if (!cmd) return { ready: false, reason: 'could not read pane state', code: 'unreadable' };
	if (!claudeCommands.includes(cmd)) {
		return { ready: false, reason: `pane is running '${cmd}', not Claude Code`, code: 'not-claude' };
	}
	// pane_in_mode is 0 or 1; treat anything but a clean 0 as not-ready.
	if (inMode !== '0') {
		return inMode === '1'
			? { ready: false, reason: 'pane is in copy-mode', code: 'copy-mode' }
			: { ready: false, reason: 'could not read pane state', code: 'unreadable' };
	}
	return { ready: true };
}

// tier-1 readiness guard the inject endpoints (3.1–3.3, 4.3) call before any
// send-keys. Returns a verdict rather than throwing so a route can answer a clean
// "not ready" instead of a hard error. A pane that no longer exists reads as
// not-ready. See parsePaneReadiness for the deliberate limits of this check.
export async function paneAcceptsInput(pane: string): Promise<PaneReadiness> {
	if (!isValidPane(pane))
		return { ready: false, reason: `invalid pane id '${pane}'`, code: 'invalid-pane' };
	let stdout: string;
	try {
		({ stdout } = await execFileAsync('tmux', [
			'display-message',
			'-p',
			'-t',
			pane,
			'#{pane_current_command}|#{pane_in_mode}'
		]));
	} catch {
		return { ready: false, reason: `pane '${pane}' no longer exists`, code: 'gone' };
	}
	return parsePaneReadiness(stdout);
}

// paneAcceptsInput, but recover from the one not-ready reason that's the user's
// view rather than a hard blocker: a pane scrolled up into copy-mode. tmux routes
// send-keys to the copy-mode key table while a pane is in mode, so a /voice Space
// would page the scrollback instead of reaching Claude — so we drop the pane back
// to the live prompt and re-check. Hold-to-record (and its stop) then work even
// while the user is reading scrollback, at the cost of snapping their view to the
// bottom (the dictation lands in the prompt there anyway). Every OTHER not-ready
// reason — not Claude, pane gone, unreadable — is returned unchanged; those aren't
// ours to override. If leaving copy-mode fails, the original copy-mode verdict is
// returned and the caller refuses exactly as before.
export async function ensurePaneInputReady(pane: string): Promise<PaneReadiness> {
	const verdict = await paneAcceptsInput(pane);
	if (verdict.ready || verdict.code !== 'copy-mode') return verdict;
	try {
		await exitCopyMode(pane);
	} catch {
		return verdict;
	}
	return paneAcceptsInput(pane);
}
