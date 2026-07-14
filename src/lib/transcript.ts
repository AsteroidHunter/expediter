import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { agentForPath, type Agent } from './agent';

type TextBlock = { type: 'text'; text: string };
type ContentBlock = TextBlock | { type: 'thinking' } | { type: 'tool_use' } | { type: string };

type TranscriptLine = {
	type?: string;
	// User messages often carry a plain string here; assistant messages carry
	// the structured content-block array.
	message?: { content?: ContentBlock[] | string };
	// Present on `type: 'custom-title'` lines — written by Claude's auto-titler
	// and by /rename. The last such line in the JSONL is the current title.
	customTitle?: string;
};

function isTextBlock(b: ContentBlock): b is TextBlock {
	return b.type === 'text' && typeof (b as TextBlock).text === 'string';
}

// Codex rollout lines (envelope pinned live on 0.144.1, see the
// codex-compatibility plan): user/assistant turns are `response_item`
// envelopes whose payload is `{type: "message", role, content: [...]}` with
// `input_text` (user) / `output_text` (assistant) blocks. All other envelope
// types (session_meta, event_msg, world_state, turn_context, compacted, …)
// are skipped by the reader.
type CodexContentBlock = { type?: string; text?: unknown };
type CodexLine = {
	type?: string;
	payload?: {
		type?: string;
		role?: string;
		content?: CodexContentBlock[];
	};
};

function extractCodexTurn(parsed: CodexLine): { role: 'user' | 'assistant'; text: string } | null {
	if (parsed.type !== 'response_item') return null;
	const p = parsed.payload;
	if (!p || p.type !== 'message') return null;
	if (p.role !== 'user' && p.role !== 'assistant') return null;
	if (!Array.isArray(p.content)) return null;
	const text = p.content
		.filter(
			(b) => (b?.type === 'input_text' || b?.type === 'output_text') && typeof b.text === 'string'
		)
		.map((b) => b.text as string)
		.join('')
		.trim();
	if (!text) return null;
	return { role: p.role, text };
}

// Containment roots for transcript_path. Defense-in-depth against a request body
// supplying e.g. /etc/passwd or ~/.ssh/id_ed25519 and getting it forwarded to
// the Anthropic summarize call. The gate in src/hooks.server.ts is the primary
// shield; this is the fallback if the gate is ever loosened or bypassed.
// Hard-coded because adapter-node refuses to start if any non-allowlisted
// EXPEDITER_* env var is set (build/env.js validates the prefix strictly).
// Claude transcripts live under ~/.claude, Codex rollouts under ~/.codex.
const TRANSCRIPT_ROOT = path.resolve(path.join(os.homedir(), '.claude'));
const CODEX_TRANSCRIPT_ROOT = path.resolve(path.join(os.homedir(), '.codex'));

function isWithinTranscriptRoots(resolved: string): boolean {
	for (const root of [TRANSCRIPT_ROOT, CODEX_TRANSCRIPT_ROOT]) {
		if (resolved === root || resolved.startsWith(root + path.sep)) return true;
	}
	return false;
}

function extractText(parsed: TranscriptLine): string {
	const content = parsed.message?.content;
	if (typeof content === 'string') return content.trim();
	if (Array.isArray(content)) {
		return content
			.filter(isTextBlock)
			.map((b) => b.text)
			.join('')
			.trim();
	}
	return '';
}

// Returns up to ~maxChars of the most recent user/assistant turns formatted as
// a chat transcript ("User: ...\n\nAssistant: ..."). Eliminates the previous
// race condition where reading only assistant text on a fresh Stop event would
// return null because the assistant message hadn't been flushed yet — user
// messages are always in the transcript by the time any hook fires.
export async function recentTranscriptText(
	transcriptPath: string,
	maxChars = 2000
): Promise<string | null> {
	// const t0 = Date.now();
	// const log = (msg: string): void => {
	// 	console.log(`[trace:transcript T+${Date.now() - t0}ms] ${msg}`);
	// };
	const resolved = path.resolve(transcriptPath);
	if (!isWithinTranscriptRoots(resolved)) {
		console.warn(`[transcript] rejected path outside root: ${resolved}`);
		return null;
	}
	// Line schema is per-agent: Claude's user/assistant lines vs Codex's
	// response_item envelopes. Selected once per file from the path segment.
	const agent = agentForPath(resolved) ?? 'claude';

	// log(`readFile start: ${resolved}`);
	let raw: string;
	try {
		raw = await readFile(resolved, 'utf8');
	} catch {
		// log(`readFile failed: ${e}`);
		return null;
	}
	// log(`readFile done; bytes=${raw.length}`);
	const lines = raw.split('\n');
	// log(`split done; lines=${lines.length}`);

	const entries: string[] = [];
	let total = 0;
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i];
		if (!line) continue;
		let parsed: TranscriptLine & CodexLine;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}
		let role: 'user' | 'assistant';
		let text: string;
		if (agent === 'codex') {
			const turn = extractCodexTurn(parsed);
			if (!turn) continue;
			({ role, text } = turn);
		} else {
			if (parsed.type !== 'user' && parsed.type !== 'assistant') continue;
			text = extractText(parsed);
			if (!text) continue;
			role = parsed.type;
		}
		const formatted = `${role === 'user' ? 'User' : 'Assistant'}: ${text}`;
		entries.unshift(formatted);
		total += formatted.length + 2; // +2 for the joining "\n\n"
		if (total >= maxChars) break;
	}

	if (entries.length === 0) return null;
	const joined = entries.join('\n\n');
	return joined.length > maxChars ? joined.slice(joined.length - maxChars) : joined;
}

// Scans the JSONL backward for the most recent `type: 'custom-title'` line and
// returns its `customTitle` field. Both Claude's auto-titler and /rename write
// the same line type, so the most recent one is canonical. Returns null when
// the file is missing, the title is empty, or no `custom-title` lines exist
// (e.g. brand-new session before Claude has written one).
export async function latestCustomTitle(transcriptPath: string): Promise<string | null> {
	const resolved = path.resolve(transcriptPath);
	if (!isWithinTranscriptRoots(resolved)) {
		console.warn(`[transcript] rejected path outside root: ${resolved}`);
		return null;
	}

	let raw: string;
	try {
		raw = await readFile(resolved, 'utf8');
	} catch {
		return null;
	}

	const lines = raw.split('\n');
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i];
		if (!line) continue;
		let parsed: TranscriptLine;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}
		if (parsed.type !== 'custom-title') continue;
		const title = parsed.customTitle;
		if (typeof title !== 'string') continue;
		const trimmed = title.trim();
		if (!trimmed) continue;
		return trimmed;
	}
	return null;
}

// ─── Codex chat titles (threads.title in the state db) ──────────────────────

// Codex persists a human-readable title for every thread in the `threads`
// table of ~/.codex/state_5.sqlite — auto-filled from the first user message,
// updated on rename. This read-only one-row SELECT is the Codex counterpart of
// latestCustomTitle: always present, rename-aware, no process spawn. The db
// runs in WAL mode, so reading alongside a live Codex is safe by design.
// Assumes the default db location (plan assumption 6): a Mac-side
// CODEX_SQLITE_HOME / sqlite_home override degrades local Codex titles to the
// whimsical fallback with a logged miss, never a crash.
const CODEX_STATE_DB = path.join(os.homedir(), '.codex', 'state_5.sqlite');

// The daemon runs under Bun in production (bun:sqlite; Bun 1.3 has no
// node:sqlite) but under Node in vite dev (node:sqlite; no bun:sqlite). Both
// expose the same prepare/get/close surface, so pick by runtime at call time.
// Imports are dynamic — and the bun specifier is computed — so neither
// runtime, nor vite's static analysis, ever tries to resolve the other's
// module.
type SqliteRowReader = {
	get: (sessionId: string) => unknown;
	close: () => void;
};

async function openThreadsReader(dbPath: string): Promise<SqliteRowReader> {
	const sql = 'SELECT title FROM threads WHERE id = ?';
	if (process.versions.bun) {
		const specifier = 'bun:sqlite';
		const { Database } = (await import(/* @vite-ignore */ specifier)) as {
			Database: new (
				p: string,
				opts: { readonly: boolean }
			) => { prepare: (s: string) => { get: (id: string) => unknown }; close: () => void };
		};
		const db = new Database(dbPath, { readonly: true });
		return { get: (id) => db.prepare(sql).get(id), close: () => db.close() };
	}
	const specifier = 'node:sqlite';
	const { DatabaseSync } = (await import(/* @vite-ignore */ specifier)) as {
		DatabaseSync: new (
			p: string,
			opts: { readOnly: boolean }
		) => { prepare: (s: string) => { get: (id: string) => unknown }; close: () => void };
	};
	const db = new DatabaseSync(dbPath, { readOnly: true });
	return { get: (id) => db.prepare(sql).get(id), close: () => db.close() };
}

// Per-agent local chat-title router (plan 3.1): claude reads the transcript's
// latest custom-title line; codex reads threads.title from the state db —
// never a summarizer spawn, so a codex ticket has no claude dependency. Local
// sessions only: remote titles arrive via payload passthrough and are never
// re-derived on this machine.
export async function localChatTitle(
	agent: Agent,
	sessionId: string,
	transcriptPath: string,
	codexDbPath?: string
): Promise<string | null> {
	if (agent === 'codex') return codexThreadTitle(sessionId, codexDbPath);
	return latestCustomTitle(transcriptPath);
}

export async function codexThreadTitle(
	sessionId: string,
	dbPath: string = CODEX_STATE_DB
): Promise<string | null> {
	let reader: SqliteRowReader;
	try {
		reader = await openThreadsReader(dbPath);
	} catch (err) {
		// Missing db (fresh codex, or a sqlite_home override — assumption 6) or
		// an unreadable file. Logged miss; the caller keeps the whimsical title.
		console.warn(`[codexTitle] state db open failed: ${err}`);
		return null;
	}
	try {
		const row = reader.get(sessionId) as { title?: unknown } | undefined | null;
		const title = row && typeof row.title === 'string' ? row.title.trim() : '';
		return title || null;
	} catch (err) {
		console.warn(`[codexTitle] threads read failed: ${err}`);
		return null;
	} finally {
		try {
			reader.close();
		} catch {
			/* already closed */
		}
	}
}
