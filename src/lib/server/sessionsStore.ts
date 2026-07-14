import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export type SessionEntry = {
	session_id: string;
	tmux_pane: string;
	cwd: string;
	transcript_path: string;
	// True for a session running on another machine over ssh: tmux_pane is the
	// local pane holding the ssh client, transcript_path is a far-side path
	// (stored, never read — decision 9), and prune/reseed judge liveness by
	// pane existence rather than pane-runs-claude. Absent means local.
	remote?: boolean;
	// Latest payload title for a remote session. The Mac can't read a remote
	// transcript, so boot reseed recovers the title from here instead
	// (decision 13). Absent for local sessions (their titles re-derive from
	// the local transcript).
	title?: string;
	// Pid of the LOCAL agent process (claude/codex) behind this session,
	// resolved at SessionStart via a pane-pid → child walk. Boot recovery
	// accepts a local entry only while this pid is alive and still parented by
	// the same pane shell — closing the hole where a replaced process in the
	// same pane inherits a dead session's identity. Never set for remote
	// entries: there is no local agent process to check, and far-end liveness
	// is accepted blindness (remote decisions 5/6).
	agent_pid?: number;
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
		const entry: SessionEntry = {
			session_id: v.session_id,
			tmux_pane: v.tmux_pane,
			cwd: v.cwd,
			transcript_path: v.transcript_path
		};
		// Optional fields are copied only when well-typed, so a sessions.json
		// written before these fields existed parses as local/untitled.
		if (v.remote === true) entry.remote = true;
		if (typeof v.title === 'string' && v.title) entry.title = v.title;
		if (typeof v.agent_pid === 'number' && Number.isFinite(v.agent_pid) && v.agent_pid > 0) {
			entry.agent_pid = v.agent_pid;
		}
		map[key] = entry;
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

// Updates the persisted title of an existing entry — the write path behind
// decision 13 (remote titles must survive a daemon restart, and the transcript
// they'd otherwise re-derive from is on the far box). No-ops when the entry is
// missing (SessionStart hasn't landed yet) or the title is unchanged, so the
// per-event call from the hook handler stays write-free in the steady state.
export async function updateSessionTitle(session_id: string, title: string): Promise<void> {
	const map = await loadSessions();
	const entry = map[session_id];
	if (!entry || entry.title === title) return;
	entry.title = title;
	await writeSessions(map);
}

export async function forgetSession(session_id: string): Promise<void> {
	const map = await loadSessions();
	if (!(session_id in map)) return;
	delete map[session_id];
	await writeSessions(map);
}

// Drops every entry whose tmux_pane is no longer alive, cleaning up orphans
// left behind by SIGKILL'd agents (where SessionEnd never fired). Liveness is
// judged per entry: a local entry's pane must still run an agent binary
// (liveAgentPaneIds — claude or codex), while a remote entry's pane runs `ssh`
// by design, so mere pane existence (allPaneIds) is the strongest liveness
// signal this machine has for it. No-ops the write if nothing changed.
export async function pruneStaleSessions(
	liveAgentPaneIds: Set<string>,
	allPaneIds: Set<string>
): Promise<void> {
	const map = await loadSessions();
	let changed = false;
	for (const [key, entry] of Object.entries(map)) {
		const liveSet = entry.remote ? allPaneIds : liveAgentPaneIds;
		if (!liveSet.has(entry.tmux_pane)) {
			delete map[key];
			changed = true;
		}
	}
	if (changed) await writeSessions(map);
}
