import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
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

// Walks a single level down from the shell PID looking for a claude child.
// Returns the matching child's argv (via `ps -o command=`) or null. Per the
// plan's Future Refinements, this is intentionally single-level — wrappers
// like `nohup claude &` would nest claude deeper and need a recursive walk;
// the normal `tmux → bash → claude` topology is single-level.
export async function claudeArgvFor(panePid: number): Promise<string | null> {
	let pids: string[];
	try {
		const { stdout } = await execFileAsync('pgrep', ['-P', String(panePid)]);
		pids = stdout
			.split('\n')
			.map((s) => s.trim())
			.filter(Boolean);
	} catch {
		return null;
	}
	for (const pid of pids) {
		try {
			const { stdout } = await execFileAsync('ps', ['-o', 'command=', '-p', pid]);
			const argv = stdout.trim();
			const firstToken = argv.split(/\s+/)[0] ?? '';
			const basename = path.basename(firstToken);
			if (CLAUDE_COMMANDS.has(basename)) return argv;
		} catch {
			continue;
		}
	}
	return null;
}

// Extracts `--name <value>` from a claude argv string. Handles space-separated
// (`--name foo`) and equals form (`--name=foo`), with optional single or
// double quoting around the value. Returns null when no `--name` flag is
// present. Argv is the authoritative source — pane_title can be overridden
// by tmux config or shell escapes; argv cannot.
export function parseName(argv: string): string | null {
	const eq = argv.match(/--name=("([^"]+)"|'([^']+)'|(\S+))/);
	if (eq) return eq[2] ?? eq[3] ?? eq[4] ?? null;
	const sp = argv.match(/--name\s+("([^"]+)"|'([^']+)'|(\S+))/);
	if (sp) return sp[2] ?? sp[3] ?? sp[4] ?? null;
	return null;
}

// Claude Code stores per-cwd transcripts under ~/.claude/projects/<slug>/,
// where the slug is the absolute cwd with `/` replaced by `-`. The leading
// slash becomes a leading `-`. Mirrors Claude Code's own on-disk layout.
export function slugify(cwd: string): string {
	return cwd.replace(/\//g, '-');
}

// Scans ~/.claude/projects/<slug>/ for the jsonl whose latest custom-title
// equals the provided name. Returns the matching session_id (jsonl filename
// minus extension) and transcript_path, or null when nothing matches. Linear
// scan over the directory — small cardinality in practice; if a project
// accumulates hundreds of jsonls the scan still completes in well under a
// second because latestCustomTitle does a single backwards walk per file.
export async function findSessionIdByName(
	cwd: string,
	name: string
): Promise<{ session_id: string; transcript_path: string } | null> {
	const slug = slugify(cwd);
	const projectDir = path.join(os.homedir(), '.claude', 'projects', slug);
	let entries: string[];
	try {
		entries = await readdir(projectDir);
	} catch {
		return null;
	}
	for (const entry of entries) {
		if (!entry.endsWith('.jsonl')) continue;
		const filePath = path.join(projectDir, entry);
		const title = await latestCustomTitle(filePath).catch(() => null);
		if (title === name) {
			return {
				session_id: entry.slice(0, -'.jsonl'.length),
				transcript_path: filePath
			};
		}
	}
	return null;
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

export function upsertPlaceholder(pane_id: string, cwd: string, title?: string): void {
	const key = `pending:${pane_id}`;
	upsert({
		session_id: key,
		tmux_pane: pane_id,
		cwd,
		title: title ?? whimsicalName(key),
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

	// Index persisted entries by tmux_pane for O(1) match per live pane.
	const byPane = new Map<string, SessionEntry>();
	for (const entry of Object.values(persisted)) {
		if (livePaneIds.has(entry.tmux_pane)) byPane.set(entry.tmux_pane, entry);
	}

	for (const pane of claudePanes) {
		const persistedEntry = byPane.get(pane.pane_id);
		if (persistedEntry) {
			upsertIdle(persistedEntry, bootScanInitialTitle(persistedEntry.session_id));
			continue;
		}
		const argv = await claudeArgvFor(pane.pane_pid);
		const name = argv ? parseName(argv) : null;
		if (name) {
			const hit = await findSessionIdByName(pane.pane_current_path, name);
			if (hit) {
				const entry: SessionEntry = {
					session_id: hit.session_id,
					tmux_pane: pane.pane_id,
					cwd: pane.pane_current_path,
					transcript_path: hit.transcript_path
				};
				await recordSession(entry).catch((e) =>
					console.warn('[bootScan] recordSession failed', e)
				);
				// Named-session match: the title is already known (we matched on it),
				// so seed it directly instead of waiting for the async upgrade.
				upsertIdle(entry, name);
				continue;
			}
		}
		// Synthetic `pending:<pane>` placeholder. When --name was present we
		// pass it through as the title even without a jsonl match — the user
		// explicitly named the session, so the whimsical fallback would lie.
		// Not persisted to sessions.json — the first real hook event for this
		// pane will reconcile via reconcilePlaceholder + recordSession.
		upsertPlaceholder(pane.pane_id, pane.pane_current_path, name ?? undefined);
	}
}
