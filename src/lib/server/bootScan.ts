import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';

import { upsert, setCachedTitle, setAttached, list, remove, findByPane } from '$lib/ticketStore';
import { whimsicalName } from '$lib/whimsicalName';
import { getTitleSource } from '$lib/config';
import { localChatTitle } from '$lib/transcript';
import { agentForCommand, agentForPath, type Agent } from '$lib/agent';
import {
	loadSessions,
	recordSession,
	pruneStaleSessions,
	type SessionEntry
} from './sessionsStore';

const execFileAsync = promisify(execFile);

// Local-pane agent detection: which agent binary (claude | codex) runs in the
// pane's foreground, or null for any other command. Generalizes the old
// claude-only CLAUDE_COMMANDS set — the local lifecycle rules (placeholder
// seeding, prune, GC) apply to every agent pane identically.
export function paneAgent(row: PaneRow): Agent | null {
	return agentForCommand(row.pane_current_command);
}

export function isLocalAgentPane(row: PaneRow): boolean {
	return paneAgent(row) !== null;
}

export type PaneRow = {
	pane_id: string;
	pane_pid: number;
	pane_current_command: string;
	pane_current_path: string;
	// True when the pane's tmux session has at least one attached client.
	// `#{session_attached}` is a client count, so `> 0` (not `=== 1`) — a
	// session with 2+ attached clients is still attached.
	session_attached: boolean;
};

// Parses the `|`-delimited rows emitted by `tmux list-panes -F`. One row per
// line; malformed rows are skipped silently (defensive against shell-injected
// or escaped path characters that could split a row early). Column order is
// pane_id | pane_pid | command | session_attached | cwd — cwd is last and
// rejoined from the remaining parts so a `|` inside a path (rare but legal)
// doesn't corrupt the session_attached column.
export function parsePaneRows(stdout: string): PaneRow[] {
	const rows: PaneRow[] = [];
	for (const line of stdout.split('\n')) {
		if (!line) continue;
		const parts = line.split('|');
		if (parts.length < 5) continue;
		const [pane_id, pidStr, cmd, attachedStr] = parts;
		const cwd = parts.slice(4).join('|');
		const pane_pid = Number(pidStr);
		if (!Number.isFinite(pane_pid)) continue;
		rows.push({
			pane_id,
			pane_pid,
			pane_current_command: cmd,
			pane_current_path: cwd,
			session_attached: Number(attachedStr) > 0
		});
	}
	return rows;
}

export async function listPanes(): Promise<PaneRow[]> {
	const { stdout } = await execFileAsync('tmux', [
		'list-panes',
		'-a',
		'-F',
		'#{pane_id}|#{pane_pid}|#{pane_current_command}|#{session_attached}|#{pane_current_path}'
	]);
	return parsePaneRows(stdout);
}

// Claude Code stores per-cwd transcripts under ~/.claude/projects/<slug>/,
// where the slug is the absolute cwd with `/` replaced by `-`. The leading
// slash becomes a leading `-`. Mirrors Claude Code's own on-disk layout.
export function slugify(cwd: string): string {
	return cwd.replace(/\//g, '-');
}

export type SessionMeta = {
	pid: number;
	sessionId: string;
	name: string;
	cwd: string;
};

// Each running claude writes ~/.claude/sessions/<pid>.json with its sessionId,
// name (from --name or /rename), and cwd. This file is the authoritative
// source for boot-scan identification — argv parsing is unreliable (the
// --resume picker leaves no name on the CLI) and pgrep-P is racy during
// claude startup. Reading the metadata directory and walking up via
// parent-pid sidesteps both problems.
export function parseSessionMeta(raw: string): SessionMeta | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
	const p = parsed as Record<string, unknown>;
	if (
		typeof p.pid !== 'number' ||
		typeof p.sessionId !== 'string' ||
		typeof p.cwd !== 'string'
	) {
		return null;
	}
	return {
		pid: p.pid,
		sessionId: p.sessionId,
		name: typeof p.name === 'string' ? p.name : '',
		cwd: p.cwd
	};
}

export async function readSessionMetas(): Promise<SessionMeta[]> {
	const dir = path.join(os.homedir(), '.claude', 'sessions');
	let entries: string[];
	try {
		entries = await readdir(dir);
	} catch {
		return [];
	}
	const out: SessionMeta[] = [];
	for (const entry of entries) {
		if (!entry.endsWith('.json')) continue;
		let raw: string;
		try {
			raw = await readFile(path.join(dir, entry), 'utf8');
		} catch {
			continue;
		}
		const meta = parseSessionMeta(raw);
		if (meta) out.push(meta);
	}
	return out;
}

// `ps -o ppid= -p <pid>` returns the parent pid, or fails with non-zero exit
// when the pid is dead. Returning null on failure lets the caller discard
// stale metadata files (claude exited without cleanup).
export async function parentPid(pid: number): Promise<number | null> {
	try {
		const { stdout } = await execFileAsync('ps', ['-o', 'ppid=', '-p', String(pid)]);
		const n = Number(stdout.trim());
		return Number.isFinite(n) && n > 0 ? n : null;
	} catch {
		return null;
	}
}

// Resolve the pid of the agent process (claude/codex) running in a pane:
// pane shell pid → direct children → first child whose command basename is a
// known agent binary. Called by the hook server at SessionStart (local
// sessions only) to record the agent_pid guard on the persisted entry. Any
// failure — pane gone, no children, ps racing a dying pid — resolves null,
// which simply degrades boot recovery for that session to the placeholder.
async function defaultResolveAgentPid(paneId: string): Promise<number | null> {
	let panePid: number;
	try {
		const { stdout } = await execFileAsync('tmux', [
			'display-message',
			'-p',
			'-t',
			paneId,
			'#{pane_pid}'
		]);
		panePid = Number(stdout.trim());
	} catch {
		return null;
	}
	if (!Number.isFinite(panePid) || panePid <= 0) return null;
	let kids: string;
	try {
		({ stdout: kids } = await execFileAsync('pgrep', ['-P', String(panePid)]));
	} catch {
		return null; // pgrep exits non-zero when the shell has no children
	}
	for (const line of kids.split('\n')) {
		const pid = Number(line.trim());
		if (!Number.isFinite(pid) || pid <= 0) continue;
		try {
			const { stdout: comm } = await execFileAsync('ps', ['-o', 'comm=', '-p', String(pid)]);
			const base = comm.trim().split('/').pop() ?? '';
			if (agentForCommand(base)) return pid;
		} catch {
			continue; // pid died between pgrep and ps
		}
	}
	return null;
}

// Injectable indirection so the hook-server tests don't shell out to the real
// tmux/pgrep/ps (pane ids like %1 can exist on the developer's live tmux and
// would resolve nondeterministically). Mirrors sshCorrelation's
// setCorrelationDepsForTest pattern.
let agentPidResolver: (paneId: string) => Promise<number | null> = defaultResolveAgentPid;

export function setAgentPidResolverForTest(
	fn?: (paneId: string) => Promise<number | null>
): void {
	agentPidResolver = fn ?? defaultResolveAgentPid;
}

export function resolveAgentPid(paneId: string): Promise<number | null> {
	return agentPidResolver(paneId);
}

// Mirrors resolveDisplayTitle from the hook handler: chat-title mode returns
// a deterministic whimsical fallback so the ticket never renders blank; haiku
// mode leaves the title empty for the SSE live-patch to fill in later.
function bootScanInitialTitle(session_id: string): string {
	if (getTitleSource() === 'chat-title') return whimsicalName(session_id);
	return '';
}

function upsertIdle(entry: SessionEntry, initialTitle: string): void {
	// Re-derived from the stored transcript_path on every reseed (segment
	// match — classifies far-side remote paths too); entries never persist
	// an agent field of their own.
	const agent = agentForPath(entry.transcript_path) ?? 'claude';
	upsert({
		session_id: entry.session_id,
		tmux_pane: entry.tmux_pane,
		cwd: entry.cwd,
		title: initialTitle,
		event_type: 'Idle',
		created_at: Date.now(),
		remote: entry.remote ?? false,
		// The far-side pane id rides back into the ticket so a reseeded
		// remote-tmux sibling keeps its uniqueness cell and its tap target.
		...(entry.remote_pane ? { remote_pane: entry.remote_pane } : {}),
		agent
	});
	// A remote entry's transcript_path points at the far box — unreadable here
	// (decision 9). The persisted title passed in initialTitle is the only
	// title source; the next remote event refreshes it via payload passthrough.
	if (entry.remote) return;
	// Async title upgrade. A real title from the agent's own source (claude:
	// the jsonl's custom-title line; codex: its explicit thread name)
	// supersedes the whimsical fallback via setCachedTitle's live-patch.
	void localChatTitle(agent, entry.session_id, entry.transcript_path)
		.then((t) => {
			if (t) setCachedTitle(entry.session_id, t);
		})
		.catch(() => {});
}

export function upsertPlaceholder(pane_id: string, cwd: string, agent: Agent = 'claude'): void {
	const key = `pending:${pane_id}`;
	upsert({
		session_id: key,
		tmux_pane: pane_id,
		cwd,
		title: whimsicalName(key),
		event_type: 'Idle',
		created_at: Date.now(),
		agent
	});
}

// The three side-effecting inputs runBootScan depends on, injectable so tests
// can feed synthetic pane/metadata/parent-pid combinations without shelling
// out to tmux/ps or touching ~/.claude/sessions. Defaults to the real
// implementations in production.
export type BootScanDeps = {
	listPanes: () => Promise<PaneRow[]>;
	readSessionMetas: () => Promise<SessionMeta[]>;
	parentPid: (pid: number) => Promise<number | null>;
};

// Production defaults for the injectable side-effecting inputs. Tests pass their
// own BootScanDeps; everything else uses the real tmux/ps/fs implementations.
const defaultDeps: BootScanDeps = { listPanes, readSessionMetas, parentPid };

// Full reconcile: read tmux truth, refresh the attach flag on existing tickets,
// seed Idle tickets for local agent panes (claude or codex) that have none yet
// (attached OR detached), and GC tickets whose pane is gone. Used by the boot
// scan and the slow poll — the heavyweight path (reads ~/.claude/sessions
// metadata + a ps walk + disk).
// It NEVER overwrites event_type / working / title on a ticket that already
// exists: those belong to the hook-event pipeline, and re-seeding would race it.
async function fullReconcile(deps: BootScanDeps): Promise<void> {
	// Captured BEFORE the async tmux read so GC can spare any ticket the hook
	// pipeline created while we were awaiting (its pane won't be in our snapshot,
	// but it is younger than this scan). Mirrors the removeIfMatch created_at
	// idiom and closes the reconcile-vs-hook GC race.
	const start = Date.now();

	let panes: PaneRow[];
	try {
		panes = await deps.listPanes();
	} catch (err) {
		console.warn('[reconcile] tmux list-panes failed (tmux not running?):', err);
		return;
	}
	const agentPanes = panes.filter(isLocalAgentPane);
	// livePaneIds intentionally includes detached panes: a detached session is
	// still alive (its agent process is running), so pruneStaleSessions must
	// not drop its persisted record just because no client is attached.
	const livePaneIds = new Set(agentPanes.map((p) => p.pane_id));
	// Remote tickets are judged against ALL panes, not agent panes: their
	// local pane runs `ssh`, and pane existence is the strongest liveness
	// signal this machine has for a far-end agent (decision 5 — an exited
	// remote agent behind a live ssh pane is accepted blindness).
	const allPaneIds = new Set(panes.map((p) => p.pane_id));

	const persisted = await loadSessions();
	await pruneStaleSessions(livePaneIds, allPaneIds);

	const byPane = new Map<string, SessionEntry>();
	for (const entry of Object.values(persisted)) {
		// Remote entries are excluded: they reseed through their own loop below,
		// and a remote entry whose pane now runs a *local* agent is stale by
		// definition (the topology changed under it) — the placeholder path plus
		// the first real hook event rekey the pane correctly.
		if (!entry.remote && livePaneIds.has(entry.tmux_pane)) byPane.set(entry.tmux_pane, entry);
	}

	// shell_pid → SessionMeta. Built from ~/.claude/sessions/*.json by walking
	// each metadata file's pid up to its parent (the tmux pane shell). Dead
	// metadata drops out when parentPid returns null.
	const metas = await deps.readSessionMetas();
	const metaByShellPid = new Map<number, SessionMeta>();
	for (const meta of metas) {
		const ppid = await deps.parentPid(meta.pid);
		if (ppid === null) continue;
		metaByShellPid.set(ppid, meta);
	}

	for (const pane of agentPanes) {
		// A ticket already bound to this pane (the steady-state poll case): only
		// refresh its attach flag. Never re-seed — that would clobber
		// event_type / working / title owned by the hook pipeline. Session-id
		// divergence (a rewind, or a new agent in a reused pane) is healed by the
		// hook pipeline's dropPaneTicketsExcept / rebindPaneTicket, not here.
		const existing = findByPane(pane.pane_id);
		if (existing) {
			setAttached(existing.session_id, pane.session_attached);
			continue;
		}
		// No ticket yet — seed one (attached OR detached) and set its real attach
		// flag. Metadata-first for claude panes: the persisted entry can be stale
		// (the previous claude in this pane exited and a new one took its place),
		// so the live metadata file wins to avoid keying the ticket by a dead
		// session_id, which would break markWorking lookups for the live claude's
		// hook events. Codex writes no such file — its panes go straight to the
		// pid-guarded persisted entry below.
		const meta =
			paneAgent(pane) === 'claude' ? metaByShellPid.get(pane.pane_pid) : undefined;
		if (meta) {
			const transcriptPath = path.join(
				os.homedir(),
				'.claude',
				'projects',
				slugify(meta.cwd),
				`${meta.sessionId}.jsonl`
			);
			const entry: SessionEntry = {
				session_id: meta.sessionId,
				tmux_pane: pane.pane_id,
				cwd: meta.cwd,
				transcript_path: transcriptPath
			};
			await recordSession(entry).catch((e) =>
				console.warn('[reconcile] recordSession failed', e)
			);
			upsertIdle(entry, meta.name || bootScanInitialTitle(meta.sessionId));
			setAttached(entry.session_id, pane.session_attached);
			continue;
		}
		// Fallback: the pid-guarded persisted entry (both agents). Accept it only
		// if its recorded agent_pid is alive and still parented by this pane's
		// shell — a dead or reparented pid means the process was replaced and the
		// entry's identity is stale (the same-pane-process-replaced hole). Local
		// entries only; remote entries reseed through their own loop below under
		// premain's pane-existence guard.
		const persistedEntry = byPane.get(pane.pane_id);
		if (
			persistedEntry &&
			typeof persistedEntry.agent_pid === 'number' &&
			(await deps.parentPid(persistedEntry.agent_pid)) === pane.pane_pid
		) {
			upsertIdle(persistedEntry, bootScanInitialTitle(persistedEntry.session_id));
			setAttached(persistedEntry.session_id, pane.session_attached);
			continue;
		}
		// Neither metadata nor a pid-valid persisted entry — the first real hook
		// event will reconcile the placeholder via dropPaneTicketsExcept.
		upsertPlaceholder(pane.pane_id, pane.pane_current_path, paneAgent(pane) ?? 'claude');
		setAttached(`pending:${pane.pane_id}`, pane.session_attached);
	}

	const rowByPane = new Map<string, PaneRow>();
	for (const p of panes) rowByPane.set(p.pane_id, p);

	// Attach sweep for remote tickets: their pane runs `ssh`, so the
	// claude-pane loop above never sees them. Same flag-flip-only contract —
	// event_type / working / title stay owned by the hook pipeline.
	for (const ticket of list()) {
		if (!ticket.remote) continue;
		const row = rowByPane.get(ticket.tmux_pane);
		if (row) setAttached(ticket.session_id, row.session_attached);
	}

	// Boot reseed for remote sessions: a persisted remote entry whose local
	// ssh pane is still alive comes back as an Idle ticket carrying the
	// persisted title (the far-side transcript is unreadable here, so the
	// title cannot be re-derived — decision 13). Panes without a persisted
	// remote entry get nothing: `pending:` placeholders are for local agent
	// panes only, and a non-agent pane with no remote history is just a shell.
	// The already-seeded guard is scoped to the entry's uniqueness CELL, not
	// the pane (D4/D8): several remote-tmux siblings legitimately persist
	// against one ssh pane, and each must come back as its own ticket — a
	// pane-wide guard would collapse them to whichever entry iterated first.
	for (const entry of Object.values(persisted)) {
		if (!entry.remote) continue;
		const row = rowByPane.get(entry.tmux_pane);
		if (!row) continue;
		if (findByPane(entry.tmux_pane, entry.remote_pane ?? '')) continue;
		upsertIdle(entry, entry.title || bootScanInitialTitle(entry.session_id));
		setAttached(entry.session_id, row.session_attached);
	}

	// GC: drop tickets whose pane is gone. A local ticket needs its pane to
	// still be a live *agent* pane (the agent exited without SessionEnd →
	// reap); a remote ticket's pane legitimately runs `ssh`, so it lives as
	// long as the pane itself does (decision 5). The created_at guard spares
	// tickets the hook pipeline created during the await above (younger than
	// `start`).
	for (const ticket of list()) {
		const paneAlive = ticket.remote
			? allPaneIds.has(ticket.tmux_pane)
			: livePaneIds.has(ticket.tmux_pane);
		if (!paneAlive && ticket.created_at < start) {
			remove(ticket.session_id);
		}
	}
}

// Light reconcile: refresh the attach flag on existing tickets and nothing else.
// Used by the tmux client-attached/-detached hook path — a client attach/detach
// only changes attach state, never creates or kills a pane, so this skips the
// metadata/ps/disk seeding AND the GC. One tmux read, flag flips only.
async function lightSync(deps: BootScanDeps): Promise<void> {
	let panes: PaneRow[];
	try {
		panes = await deps.listPanes();
	} catch (err) {
		console.warn('[reconcile:light] tmux list-panes failed:', err);
		return;
	}
	// ALL panes, not just agent panes: a remote ticket's pane runs `ssh`, and
	// its detach/attach flips must land instantly too (settled 2026-07-12). A
	// local ticket whose pane no longer runs an agent is moribund either way —
	// flipping its flag until the next full reconcile GCs it is harmless.
	const attachedByPane = new Map<string, boolean>();
	for (const p of panes) {
		attachedByPane.set(p.pane_id, p.session_attached);
	}
	// Flag-flip only. A pane missing from the snapshot is left untouched for the
	// next full reconcile (boot/poll) to seed or GC.
	for (const ticket of list()) {
		const attached = attachedByPane.get(ticket.tmux_pane);
		if (attached !== undefined) setAttached(ticket.session_id, attached);
	}
}

// Single-flight gate over the reconcile family. Every trigger (boot, tmux hooks,
// slow poll) reads tmux truth asynchronously before mutating the store, so two
// overlapping runs could write a stale attach flag. Serialize them: while one
// runs, further requests collapse into a single queued rerun, and a queued full
// subsumes a queued light (full updates attach flags too). The returned promise
// resolves once the caller's requested work (plus any rerun it triggered) ends.
let inFlight: Promise<void> | null = null;
let queuedFull = false;
let queuedLight = false;

export function reconcile(
	deps: BootScanDeps = defaultDeps,
	mode: 'full' | 'light' = 'full'
): Promise<void> {
	if (inFlight) {
		if (mode === 'full') queuedFull = true;
		else queuedLight = true;
		return inFlight;
	}
	inFlight = (async () => {
		try {
			await (mode === 'full' ? fullReconcile(deps) : lightSync(deps));
			while (queuedFull || queuedLight) {
				const runFull = queuedFull;
				queuedFull = false;
				queuedLight = false;
				await (runFull ? fullReconcile(deps) : lightSync(deps));
			}
		} finally {
			inFlight = null;
		}
	})();
	return inFlight;
}

// Boot entry point, wired in hooks.server.ts. A full reconcile that repopulates
// the in-memory store from tmux + sessions.json after a daemon (re)start.
export function runBootScan(deps: BootScanDeps = defaultDeps): Promise<void> {
	return reconcile(deps, 'full');
}

// Slow-poll interval: a full reconcile every 5 minutes as a safety net for
// missed tmux hooks and hard-crashed (no-SessionEnd) panes. The tmux-hook path
// gives instant updates; this is the floor that self-heals anything they miss.
export const RECONCILE_POLL_MS = 5 * 60 * 1000;

// Start the slow poll. Returns the timer so callers/tests can stop it. unref'd
// so it never keeps the process alive on its own. Each tick is a FULL reconcile
// (not just GC) so a missed detach/attach self-heals too, not only dead cards.
export function startReconcilePoll(
	deps: BootScanDeps = defaultDeps,
	intervalMs: number = RECONCILE_POLL_MS
): ReturnType<typeof setInterval> {
	const timer = setInterval(() => {
		void reconcile(deps, 'full').catch((e) => console.warn('[reconcile:poll]', e));
	}, intervalMs);
	timer.unref?.();
	return timer;
}
