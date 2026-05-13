import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export class FocusError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'FocusError';
	}
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

	try {
		await execFileAsync('osascript', ['-e', 'tell application "Terminal" to activate']);
	} catch {
		throw new FocusError('osascript Terminal.app activate failed');
	}
}
