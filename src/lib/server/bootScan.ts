import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';

import { upsert, setCachedTitle } from '$lib/ticketStore';
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
};

// Parses the `|`-delimited rows emitted by `tmux list-panes -F`. One row per
// line; malformed rows are skipped silently (defensive against shell-injected
// or escaped path characters that could split a row early).
export function parsePaneRows(stdout: string): PaneRow[] {
	const rows: PaneRow[] = [];
	for (const line of stdout.split('\n')) {
		if (!line) continue;
		const parts = line.split('|');
		if (parts.length < 4) continue;
		const [pane_id, pidStr, cmd, cwd] = parts;
		const pane_pid = Number(pidStr);
		if (!Number.isFinite(pane_pid)) continue;
		rows.push({ pane_id, pane_pid, pane_current_command: cmd, pane_current_path: cwd });
	}
	return rows;
}

export async function listPanes(): Promise<PaneRow[]> {
	const { stdout } = await execFileAsync('tmux', [
		'list-panes',
		'-a',
		'-F',
		'#{pane_id}|#{pane_pid}|#{pane_current_command}|#{pane_current_path}'
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

export async function runBootScan(): Promise<void> {
	let panes: PaneRow[];
	try {
		panes = await listPanes();
	} catch (err) {
		console.warn('[bootScan] tmux list-panes failed (tmux not running?):', err);
		return;
	}
	const claudePanes = panes.filter(isClaudePane);
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
	const metas = await readSessionMetas();
	const metaByShellPid = new Map<number, SessionMeta>();
	for (const meta of metas) {
		const ppid = await parentPid(meta.pid);
		if (ppid === null) continue;
		metaByShellPid.set(ppid, meta);
	}

	for (const pane of claudePanes) {
		const persistedEntry = byPane.get(pane.pane_id);
		if (persistedEntry) {
			upsertIdle(persistedEntry, bootScanInitialTitle(persistedEntry.session_id));
			continue;
		}
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
				console.warn('[bootScan] recordSession failed', e)
			);
			upsertIdle(entry, meta.name || bootScanInitialTitle(meta.sessionId));
			continue;
		}
		// No metadata for this pane's shell pid — claude hasn't written one
		// yet, or this is a non-standard launch. First real hook event will
		// reconcile via reconcilePlaceholder.
		upsertPlaceholder(pane.pane_id, pane.pane_current_path);
	}
}
