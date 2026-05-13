import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export class FocusError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'FocusError';
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

	let target: string;
	try {
		const { stdout } = await execFileAsync('tmux', [
			'display-message',
			'-p',
			'-t',
			pane,
			'#{session_name}:#{window_id}'
		]);
		target = stdout.trim();
	} catch {
		throw new FocusError(`pane '${pane}' no longer exists`);
	}

	if (!target) {
		throw new FocusError(`pane '${pane}' resolved to empty target`);
	}

	try {
		await execFileAsync('tmux', ['select-window', '-t', target]);
	} catch {
		throw new FocusError(`tmux select-window failed for '${target}'`);
	}

	const session = target.split(':')[0] ?? '';
	const tty = session ? await clientTtyForSession(session) : null;

	try {
		await execFileAsync('osascript', ['-e', raiseTerminalScript(tty)]);
	} catch {
		throw new FocusError('osascript Terminal.app activate failed');
	}
}
