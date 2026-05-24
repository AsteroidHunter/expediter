import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export type SessionEntry = {
	session_id: string;
	tmux_pane: string;
	cwd: string;
	transcript_path: string;
};

export type SessionsMap = Record<string, SessionEntry>;

const DEFAULT_SESSIONS_FILE = path.join(os.homedir(), '.expediter', 'sessions.json');

// Env-var override is read on every call so tests can swap in a tempfile per
// test without re-importing the module. Also serves as a debug knob for
// operators who want to point the daemon at an alternate file.
function currentSessionsFile(): string {
	return process.env.EXPEDITER_SESSIONS_FILE || DEFAULT_SESSIONS_FILE;
}

// Returns {} when the file is missing or malformed. Logs a warning in the
// malformed case so an operator can find it; missing is silent because a fresh
// install legitimately has no file yet.
export async function loadSessions(): Promise<SessionsMap> {
	const file = currentSessionsFile();
	let raw: string;
	try {
		raw = await readFile(file, 'utf8');
	} catch {
		return {};
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		console.warn(`[sessionsStore] sessions.json malformed; treating as empty: ${err}`);
		return {};
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		console.warn('[sessionsStore] sessions.json top-level must be an object; treating as empty.');
		return {};
	}
	// Defensive per-entry shape check. A partially-corrupt file (one bad entry
	// among many) should not lose every other session — drop only the bad ones.
	const map: SessionsMap = {};
	for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
		if (!value || typeof value !== 'object') continue;
		const v = value as Partial<SessionEntry>;
		if (
			typeof v.session_id !== 'string' ||
			typeof v.tmux_pane !== 'string' ||
			typeof v.cwd !== 'string' ||
			typeof v.transcript_path !== 'string'
		) {
			continue;
		}
		map[key] = {
			session_id: v.session_id,
			tmux_pane: v.tmux_pane,
			cwd: v.cwd,
			transcript_path: v.transcript_path
		};
	}
	return map;
}

// Atomic-replace via temp+rename. POSIX rename is atomic on the same
// filesystem, so a reader can't observe a half-written file. The temp name
// includes pid + Math.random + counter so two concurrent writers don't
// share — and stomp — the same temp path before either gets to rename.
// Last-writer-wins on the contents (no claimed file lock); at the user's
// scale (~10 claudes) simultaneous SessionStart fires are rare, and
// last-write outcomes are acceptable when they happen.
let tmpCounter = 0;
async function writeSessions(map: SessionsMap): Promise<void> {
	const file = currentSessionsFile();
	const tmp = `${file}.tmp.${process.pid}.${(++tmpCounter).toString(36)}.${Math.random()
		.toString(36)
		.slice(2, 8)}`;
	await mkdir(path.dirname(file), { recursive: true });
	const payload = JSON.stringify(map, null, 2) + '\n';
	await writeFile(tmp, payload, 'utf8');
	await rename(tmp, file);
}

export async function recordSession(entry: SessionEntry): Promise<void> {
	const map = await loadSessions();
	map[entry.session_id] = entry;
	await writeSessions(map);
}

export async function forgetSession(session_id: string): Promise<void> {
	const map = await loadSessions();
	if (!(session_id in map)) return;
	delete map[session_id];
	await writeSessions(map);
}

// Drops every entry whose tmux_pane isn't in the live set. Called once at
// boot to clean up orphans left behind by SIGKILL'd claudes (where SessionEnd
// never fired). No-ops the write if nothing changed.
export async function pruneStaleSessions(livePaneIds: Set<string>): Promise<void> {
	const map = await loadSessions();
	let changed = false;
	for (const [key, entry] of Object.entries(map)) {
		if (!livePaneIds.has(entry.tmux_pane)) {
			delete map[key];
			changed = true;
		}
	}
	if (changed) await writeSessions(map);
}
