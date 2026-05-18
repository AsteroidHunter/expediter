import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export class FocusError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'FocusError';
	}
}

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

function raiseTerminalScript(tty: string | null): string {
	if (!tty) return 'tell application "Terminal" to activate';
	// `set selected of t to true` switches the tab inside its host window.
	// `set frontmost of w to true` brings that host window forward in the
	// z-stack. We deliberately do NOT call `set index of w to 1` — it triggers
	// Terminal to re-evaluate which tab is the "primary" tab in its window
	// and snaps focus to whichever tab Terminal considers the default,
	// rather than the one we just selected. Inner try/end blocks skip
	// Terminal windows that don't expose tabs (Settings, etc.).
	const escaped = tty.replace(/"/g, '\\"');
	return `
tell application "Terminal"
	activate
	set targetTTY to "${escaped}"
	repeat with w in windows
		try
			repeat with t in tabs of w
				try
					if tty of t is targetTTY then
						set selected of t to true
						set frontmost of w to true
						return
					end if
				end try
			end repeat
		end try
	end repeat
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

	// select-pane (not select-window) so two Claude sessions sharing one tmux
	// window land on the exact pane the ticket came from instead of whichever
	// pane was last active. select-pane also makes the parent window active,
	// so no separate select-window call is needed.
	try {
		await execFileAsync('tmux', ['select-pane', '-t', pane]);
	} catch {
		throw new FocusError(`tmux select-pane failed for '${pane}'`);
	}

	const tty = await clientTtyForSession(session);
	console.log(`[focus] pane=${pane} session=${session} tty=${tty ?? '<none>'}`);

	const pre = await captureTerminalState();
	console.log(`[focus] state pre=${pre}`);

	try {
		const { stdout, stderr } = await execFileAsync('osascript', [
			'-e',
			raiseTerminalScript(tty)
		]);
		const so = stdout.trim();
		const se = stderr.trim();
		if (so || se) console.log(`[focus] osascript stdout=${so!} stderr=${se!}`);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.log(`[focus] osascript threw: ${msg}`);
		throw new FocusError('osascript Terminal.app activate failed');
	}

	const post = await captureTerminalState();
	const moved = pre !== post;
	console.log(`[focus] state post=${post} moved=${moved} wanted_tty=${tty ?? '<none>'}`);
}
