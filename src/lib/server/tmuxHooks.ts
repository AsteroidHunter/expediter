import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const execFileAsync = promisify(execFile);

const BRIDGE_NAME = 'expediter-tmux-hook.sh';

// Resolve the absolute path to bin/expediter-tmux-hook.sh at runtime. The daemon
// runs as a bundled adapter-node server started via `bun $EXPEDITER_HOME/build/
// index.js`, and the launcher deletes EXPEDITER_HOME before spawning (adapter-
// node rejects unknown EXPEDITER_* env vars) and sets no cwd — so we can rely on
// neither. Candidates, first existing wins:
//   1. prod: argv[1] = <home>/build/index.js → <home>/bin/<bridge>
//   2. dev:  this module's URL = <home>/src/lib/server/tmuxHooks.ts → <home>/bin
//   3. cwd:  <cwd>/bin/<bridge> (covers running from the repo root)
// Returns null when none exist (e.g. an unusual layout) so the caller can skip
// installing hooks rather than wire a path that doesn't resolve.
export function resolveBridgePath(): string | null {
	const candidates: string[] = [];

	const entry = process.argv[1];
	if (entry) {
		candidates.push(path.join(path.dirname(path.dirname(entry)), 'bin', BRIDGE_NAME));
	}

	try {
		const here = fileURLToPath(import.meta.url);
		// <home>/src/lib/server/tmuxHooks.ts → up 3 to <home>, then /bin
		candidates.push(path.resolve(path.dirname(here), '..', '..', '..', 'bin', BRIDGE_NAME));
	} catch {
		/* import.meta.url not a file URL (unexpected) — skip this candidate */
	}

	candidates.push(path.join(process.cwd(), 'bin', BRIDGE_NAME));

	for (const c of candidates) {
		if (existsSync(c)) return c;
	}
	return null;
}

// Install the global tmux hooks that ping the daemon on client attach/detach.
// `set-hook -g` (no `-a`) REPLACES the named hook, so re-running on every daemon
// boot is idempotent — hooks never stack. Best-effort: a missing tmux server or
// an unresolvable bridge just logs and no-ops (the slow poll still covers us).
// `run` is injectable so tests can assert the exact set-hook commands without a
// real tmux server. Returns the set-hook argv arrays it issued (for tests/logs).
export async function installTmuxHooks(
	bridge: string | null = resolveBridgePath(),
	run: (args: string[]) => Promise<void> = async (args) => {
		await execFileAsync('tmux', args);
	}
): Promise<string[][]> {
	if (!bridge) {
		console.warn(`[tmuxHooks] could not locate ${BRIDGE_NAME}; skipping tmux hook install`);
		return [];
	}
	// The hook value is a tmux command string; quote the path so a bridge under a
	// directory with spaces still parses. run-shell -b runs it detached via sh -c.
	const command = `run-shell -b "${bridge}"`;
	const issued: string[][] = [];
	for (const event of ['client-attached', 'client-detached']) {
		const args = ['set-hook', '-g', event, command];
		try {
			await run(args);
			issued.push(args);
		} catch (err) {
			console.warn(`[tmuxHooks] set-hook ${event} failed (tmux not running?):`, err);
		}
	}
	return issued;
}
