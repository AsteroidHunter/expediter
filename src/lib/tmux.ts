import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

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

async function clientTtyForWindow(windowId: string): Promise<string | null> {
	try {
		const { stdout } = await execFileAsync('tmux', [
			'list-clients',
			'-F',
			'#{client_activity}|#{client_tty}|#{window_id}'
		]);
		return pickTtyForWindow(stdout, windowId);
	} catch {
		return null;
	}
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

export function raiseTerminalScript(tty: string | null, cached: TabLocation | null): string {
	if (!tty) return 'tell application "Terminal" to activate';
	// `set selected of t to true` switches the tab inside its host window.
	// `set frontmost of w to true` brings that host window forward in the
	// z-stack. We deliberately do NOT call `set index of w to 1` — it triggers
	// Terminal to re-evaluate which tab is the "primary" tab in its window
	// and snaps focus to whichever tab Terminal considers the default,
	// rather than the one we just selected. Inner try/end blocks skip
	// Terminal windows that don't expose tabs (Settings, etc.).
	//
	// Activation timing matters: `set frontmost of <window-expr> to true`
	// issued in roughly the first 200ms after `activate` is silently dropped
	// while Terminal is mid-activation from background — the script returns
	// successfully but the z-stack isn't touched, so the tap lands on
	// whichever window was previously frontmost. Polling `frontmost` does
	// not help (the app-level property reads true while the window stack is
	// still settling), and binding the window reference to a variable does
	// not add enough latency on its own (stress-tested ~5/10). The reliable
	// fix is an explicit `delay 0.2` after activate, gated on Terminal not
	// already being frontmost so already-foregrounded taps stay fast
	// (stress-tested 10/10 with the gated delay).
	const escaped = tty.replace(/"/g, '\\"');
	// Warm (cache-hit) branch: resolve the window in ONE Apple Event via
	// `window id <id>` instead of walking `count of windows` and reading
	// `id of window wi` one at a time. That walk cost an Apple Event per window
	// (~30ms each), so every warm tap was O(window count × z-order depth) — a tab
	// buried behind a dozen Terminal windows took hundreds of ms even on a cache
	// hit. We still bind the resolved window to `w` and act on the bound
	// reference: `set frontmost` against the bare `window id <id>` specifier is
	// silently dropped mid-activation, whereas `w` survives. A stale id (window
	// closed / tab moved / tty no longer matches) throws or falls out of the try
	// and drops through to the full enumeration below, which refreshes the cache.
	const cachedBranch = cached
		? `
	try
		set w to window id ${cached.windowId}
		if tty of tab ${cached.tabIndex} of w is targetTTY then
			set selected of tab ${cached.tabIndex} of w to true
			set frontmost of w to true
			return "hit"
		end if
	end try`
		: '';
	// Cold/enumeration branch (no cache, or a cache miss): scan each window with a
	// single `tty of tabs of window wi` read — one Apple Event per window instead
	// of one per tab — and match the tty in-memory, binding `w` only on the matched
	// window so `set frontmost` still runs against a bound reference. The per-window
	// `try` skips windows that don't expose tabs (Settings, etc.), as before.
	return `
tell application "Terminal"
	set wasFront to frontmost
	activate
	if not wasFront then delay 0.2
	set targetTTY to "${escaped}"${cachedBranch}
	repeat with wi from 1 to (count of windows)
		try
			set theTtys to tty of tabs of window wi
			repeat with ti from 1 to (count of theTtys)
				if item ti of theTtys is targetTTY then
					set w to window wi
					set wid to id of w
					set selected of tab ti of w to true
					set frontmost of w to true
					return "miss:" & wid & ":" & ti
				end if
			end repeat
		end try
	end repeat
	return "notfound"
end tell`;
}

export async function focusPane(pane: string): Promise<void> {
	if (!pane || !/^%[0-9]+$/.test(pane)) {
		throw new FocusError(`invalid pane id '${pane}'`);
	}

	let windowId: string;
	let session: string;
	try {
		const { stdout } = await execFileAsync('tmux', [
			'display-message',
			'-p',
			'-t',
			pane,
			'#{window_id}|#{session_name}'
		]);
		// window_id (`@N`) never contains a pipe, so split on the first one;
		// the remainder is the session name.
		const sep = stdout.indexOf('|');
		windowId = sep >= 0 ? stdout.slice(0, sep).trim() : '';
		session = (sep >= 0 ? stdout.slice(sep + 1) : stdout).trim();
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
	let tty = windowId ? await clientTtyForWindow(windowId) : null;
	if (!tty) tty = await clientTtyForSession(session);
	debugFocus(`[focus] pane=${pane} window=${windowId} session=${session} tty=${tty ?? '<none>'}`);

	// select-window switches the session's current window to the one containing
	// the pane; select-pane then picks the exact pane within that window. Both
	// are needed: select-pane alone doesn't change the active window (so taps
	// across windows wouldn't switch), and select-window alone falls back to
	// whichever pane was last active (wrong when two Claude panes share a
	// window). Chained in one tmux invocation via ';' to avoid a second process
	// spawn.
	try {
		await execFileAsync('tmux', [
			'select-window',
			'-t',
			pane,
			';',
			'select-pane',
			'-t',
			pane
		]);
	} catch {
		throw new FocusError(`tmux select-window/select-pane failed for '${pane}'`);
	}

	// const pre = await captureTerminalState();
	// console.log(`[focus] state pre=${pre}`);

	const cached = tty ? ttyToTab.get(tty) ?? null : null;
	try {
		const { stdout, stderr } = await execFileAsync('osascript', [
			'-e',
			raiseTerminalScript(tty, cached)
		]);
		const so = stdout.trim();
		const se = stderr.trim();
		if (se) console.log(`[focus] osascript stderr=${se}`);
		if (tty) {
			const result = parseActivateResult(so);
			applyActivateResult(ttyToTab, tty, result);
			debugFocus(`[focus] activate tty=${tty} result=${so || '<empty>'} cached=${cached ? 'y' : 'n'}`);
		}
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.log(`[focus] osascript threw: ${msg}`);
		throw new FocusError('osascript Terminal.app activate failed');
	}

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
	// resolves. `do script` runs the command in a new Terminal window.
	const escapedSession = session.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
	const script = `tell application "Terminal"
	do script "tmux attach -t \\"${escapedSession}\\""
	activate
end tell`;

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
