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

async function clientTtyForSession(session: string): Promise<string | null> {
	try {
		const { stdout } = await execFileAsync('tmux', [
			'list-clients',
			'-t',
			session,
			'-F',
			'#{client_tty}'
		]);
		const tty = stdout.split('\n').map((s) => s.trim()).find((s) => s.length > 0);
		return tty ?? null;
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
	// Window reference form matters: `set frontmost of window id N to true`
	// silently fails to reorder windows when Terminal is being activated from
	// background (the property change is accepted but the z-stack is not
	// touched). `set frontmost of window <index> to true` does reorder. So
	// the cached branch resolves the saved window id to its current index by
	// iterating once over windows (cheap — no tab enumeration), validates
	// the cached tab still has the expected tty, then operates via the index
	// form. Falls through to the miss branch on any mismatch.
	const escaped = tty.replace(/"/g, '\\"');
	const cachedBranch = cached
		? `
	repeat with wi from 1 to (count of windows)
		try
			if id of window wi is ${cached.windowId} then
				try
					if tty of tab ${cached.tabIndex} of window wi is targetTTY then
						set selected of tab ${cached.tabIndex} of window wi to true
						set frontmost of window wi to true
						return "hit"
					end if
				end try
				exit repeat
			end if
		end try
	end repeat`
		: '';
	return `
tell application "Terminal"
	activate
	set targetTTY to "${escaped}"${cachedBranch}
	repeat with wi from 1 to (count of windows)
		try
			set w to window wi
			set wid to id of w
			repeat with ti from 1 to (count of tabs of w)
				try
					if tty of tab ti of w is targetTTY then
						set selected of tab ti of w to true
						set frontmost of w to true
						return "miss:" & wid & ":" & ti
					end if
				end try
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

	const tty = await clientTtyForSession(session);
	debugFocus(`[focus] pane=${pane} session=${session} tty=${tty ?? '<none>'}`);

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
