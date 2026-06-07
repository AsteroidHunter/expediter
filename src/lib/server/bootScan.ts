import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';

import { upsert, setCachedTitle, setAttached, list, remove, findByPane } from '$lib/ticketStore';
import { whimsicalName } from '$lib/whimsicalName';
import { getTitleSource } from '$lib/config';
import { latestCustomTitle } from '$lib/transcript';
import {
	loadSessions,
	recordSession,
	pruneStaleSessions,
	type SessionEntry
} from './sessionsStore';

const execFileAsync = promisify(execFile);

const CLAUDE_COMMANDS = new Set(['claude', 'claude.exe']);

export function isClaudePane(row: PaneRow): boolean {
	return CLAUDE_COMMANDS.has(row.pane_current_command);
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

// Mirrors resolveDisplayTitle from the hook handler: chat-title mode returns
// a deterministic whimsical fallback so the ticket never renders blank; haiku
// mode leaves the title empty for the SSE live-patch to fill in later.
function bootScanInitialTitle(session_id: string): string {
	if (getTitleSource() === 'chat-title') return whimsicalName(session_id);
	return '';
}

function upsertIdle(entry: SessionEntry, initialTitle: string): void {
	upsert({
		session_id: entry.session_id,
		tmux_pane: entry.tmux_pane,
		cwd: entry.cwd,
		title: initialTitle,
		event_type: 'Idle',
		created_at: Date.now()
	});
	// Async title upgrade. A real custom-title from the jsonl supersedes the
	// whimsical fallback via setCachedTitle's live-patch in the ticket store.
	void latestCustomTitle(entry.transcript_path)
		.then((t) => {
			if (t) setCachedTitle(entry.session_id, t);
		})
		.catch(() => {});
}

export function upsertPlaceholder(pane_id: string, cwd: string): void {
	const key = `pending:${pane_id}`;
	upsert({
		session_id: key,
		tmux_pane: pane_id,
		cwd,
		title: whimsicalName(key),
		event_type: 'Idle',
		created_at: Date.now()
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
// seed Idle tickets for claude panes that have none yet (attached OR detached),
// and GC tickets whose pane is gone. Used by the boot scan and the slow poll —
// the heavyweight path (reads ~/.claude/sessions metadata + a ps walk + disk).
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
	const claudePanes = panes.filter(isClaudePane);
	// livePaneIds intentionally includes detached panes: a detached session is
	// still alive (its claude process is running), so pruneStaleSessions must
	// not drop its persisted record just because no client is attached.
	const livePaneIds = new Set(claudePanes.map((p) => p.pane_id));

	const persisted = await loadSessions();
	await pruneStaleSessions(livePaneIds);

	const byPane = new Map<string, SessionEntry>();
	for (const entry of Object.values(persisted)) {
		if (livePaneIds.has(entry.tmux_pane)) byPane.set(entry.tmux_pane, entry);
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

	for (const pane of claudePanes) {
		// A ticket already bound to this pane (the steady-state poll case): only
		// refresh its attach flag. Never re-seed — that would clobber
		// event_type / working / title owned by the hook pipeline. Session-id
		// divergence (a rewind, or a new claude in a reused pane) is healed by the
		// hook pipeline's dropPaneTicketsExcept / rebindPaneTicket, not here.
		const existing = findByPane(pane.pane_id);
		if (existing) {
			setAttached(existing.session_id, pane.session_attached);
			continue;
		}
		// No ticket yet — seed one (attached OR detached) and set its real attach
		// flag. Metadata-first: the persisted entry can be stale (the previous
		// claude in this pane exited and a new one took its place), so the live
		// metadata file wins to avoid keying the ticket by a dead session_id,
		// which would break markWorking lookups for the live claude's hook events.
		const meta = metaByShellPid.get(pane.pane_pid);
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
		// Fallback: claude hasn't written a metadata file yet (older versions,
		// or brand-new process). Use the persisted entry if we have one.
		const persistedEntry = byPane.get(pane.pane_id);
		if (persistedEntry) {
			upsertIdle(persistedEntry, bootScanInitialTitle(persistedEntry.session_id));
			setAttached(persistedEntry.session_id, pane.session_attached);
			continue;
		}
		// Neither metadata nor persistence — the first real hook event will
		// reconcile the placeholder via dropPaneTicketsExcept.
		upsertPlaceholder(pane.pane_id, pane.pane_current_path);
		setAttached(`pending:${pane.pane_id}`, pane.session_attached);
	}

	// GC: drop tickets whose pane is no longer a live claude pane (claude exited,
	// or the pane died without a SessionEnd). The created_at guard spares tickets
	// the hook pipeline created during the await above (younger than `start`).
	for (const ticket of list()) {
		if (!livePaneIds.has(ticket.tmux_pane) && ticket.created_at < start) {
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
	const attachedByPane = new Map<string, boolean>();
	for (const p of panes) {
		if (isClaudePane(p)) attachedByPane.set(p.pane_id, p.session_attached);
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
