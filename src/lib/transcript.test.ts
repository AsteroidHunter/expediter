import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Database } from 'bun:sqlite';
import {
	latestCustomTitle,
	recentTranscriptText,
	codexThreadTitle,
	localChatTitle
} from './transcript';

// Tests must write under ~/.claude/ to pass transcript.ts's TRANSCRIPT_ROOT
// containment check (same constraint the production gate enforces).
let tempDir: string;
let transcriptFile: string;

beforeEach(() => {
	tempDir = mkdtempSync(path.join(os.homedir(), '.claude', '.expediter-transcript-test-'));
	transcriptFile = path.join(tempDir, 'transcript.jsonl');
});

afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

test('returns null when the file does not exist', async () => {
	expect(await latestCustomTitle(path.join(tempDir, 'missing.jsonl'))).toBeNull();
});

test('returns null when the file is empty', async () => {
	writeFileSync(transcriptFile, '');
	expect(await latestCustomTitle(transcriptFile)).toBeNull();
});

test('returns null when there are no custom-title lines', async () => {
	writeFileSync(
		transcriptFile,
		[
			JSON.stringify({ type: 'user', message: { content: 'hello' } }),
			JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } })
		].join('\n')
	);
	expect(await latestCustomTitle(transcriptFile)).toBeNull();
});

test('returns the customTitle from a single custom-title line', async () => {
	writeFileSync(
		transcriptFile,
		JSON.stringify({ type: 'custom-title', customTitle: 'refactor auth module', sessionId: 'abc' })
	);
	expect(await latestCustomTitle(transcriptFile)).toBe('refactor auth module');
});

test('returns the most recent custom-title when multiple exist', async () => {
	writeFileSync(
		transcriptFile,
		[
			JSON.stringify({ type: 'custom-title', customTitle: 'first title' }),
			JSON.stringify({ type: 'user', message: { content: 'do a thing' } }),
			JSON.stringify({ type: 'custom-title', customTitle: 'second title' }),
			JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } }),
			JSON.stringify({ type: 'custom-title', customTitle: 'latest title' })
		].join('\n')
	);
	expect(await latestCustomTitle(transcriptFile)).toBe('latest title');
});

test('skips malformed JSONL lines and keeps scanning', async () => {
	writeFileSync(
		transcriptFile,
		[
			JSON.stringify({ type: 'custom-title', customTitle: 'good title' }),
			'{not valid json',
			'',
			'   '
		].join('\n')
	);
	expect(await latestCustomTitle(transcriptFile)).toBe('good title');
});

test('skips custom-title lines with empty / whitespace-only titles', async () => {
	writeFileSync(
		transcriptFile,
		[
			JSON.stringify({ type: 'custom-title', customTitle: 'real title' }),
			JSON.stringify({ type: 'custom-title', customTitle: '   ' }),
			JSON.stringify({ type: 'custom-title', customTitle: '' })
		].join('\n')
	);
	expect(await latestCustomTitle(transcriptFile)).toBe('real title');
});

test('trims whitespace around the title', async () => {
	writeFileSync(
		transcriptFile,
		JSON.stringify({ type: 'custom-title', customTitle: '  spaced title  ' })
	);
	expect(await latestCustomTitle(transcriptFile)).toBe('spaced title');
});

test('rejects paths outside ~/.claude/', async () => {
	const outside = mkdtempSync(path.join(os.tmpdir(), 'expediter-outside-test-'));
	const outsideFile = path.join(outside, 'transcript.jsonl');
	writeFileSync(outsideFile, JSON.stringify({ type: 'custom-title', customTitle: 'sneaky' }));
	expect(await latestCustomTitle(outsideFile)).toBeNull();
	rmSync(outside, { recursive: true, force: true });
});

test('ignores custom-title lines where customTitle is not a string', async () => {
	writeFileSync(
		transcriptFile,
		[
			JSON.stringify({ type: 'custom-title', customTitle: 'valid one' }),
			JSON.stringify({ type: 'custom-title', customTitle: 123 }),
			JSON.stringify({ type: 'custom-title' })
		].join('\n')
	);
	expect(await latestCustomTitle(transcriptFile)).toBe('valid one');
});

// ─── recentTranscriptText ────────────────────────────────────────────────────

test('recentTranscriptText returns null when the file is missing', async () => {
	expect(await recentTranscriptText(path.join(tempDir, 'missing.jsonl'))).toBeNull();
});

test('recentTranscriptText returns null when the file has no user/assistant turns', async () => {
	writeFileSync(
		transcriptFile,
		[
			JSON.stringify({ type: 'system', message: 'boot' }),
			JSON.stringify({ type: 'custom-title', customTitle: 'whatever' })
		].join('\n')
	);
	expect(await recentTranscriptText(transcriptFile)).toBeNull();
});

test('recentTranscriptText formats user (string content) and assistant (block array) turns', async () => {
	writeFileSync(
		transcriptFile,
		[
			JSON.stringify({ type: 'user', message: { content: 'do a thing' } }),
			JSON.stringify({
				type: 'assistant',
				message: { content: [{ type: 'text', text: 'doing the thing' }] }
			})
		].join('\n')
	);
	const out = await recentTranscriptText(transcriptFile);
	expect(out).toContain('User: do a thing');
	expect(out).toContain('Assistant: doing the thing');
});

test('recentTranscriptText skips non-text content blocks but keeps the text ones', async () => {
	writeFileSync(
		transcriptFile,
		JSON.stringify({
			type: 'assistant',
			message: {
				content: [
					{ type: 'thinking' },
					{ type: 'text', text: 'answer body' },
					{ type: 'tool_use' }
				]
			}
		})
	);
	const out = await recentTranscriptText(transcriptFile);
	expect(out).toBe('Assistant: answer body');
});

test('recentTranscriptText respects maxChars by trimming from the start of joined output', async () => {
	const big = 'X'.repeat(2000);
	writeFileSync(
		transcriptFile,
		[
			JSON.stringify({ type: 'user', message: { content: 'oldest user message' } }),
			JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: big }] } })
		].join('\n')
	);
	const out = await recentTranscriptText(transcriptFile, 500);
	expect(out!.length).toBeLessThanOrEqual(500);
	expect(out).toContain('XXX'); // the tail of the big assistant block survives
});

test('recentTranscriptText skips malformed JSONL lines and keeps scanning', async () => {
	writeFileSync(
		transcriptFile,
		[
			JSON.stringify({ type: 'user', message: { content: 'good line' } }),
			'{not json',
			JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'after garbage' }] } })
		].join('\n')
	);
	const out = await recentTranscriptText(transcriptFile);
	expect(out).toContain('User: good line');
	expect(out).toContain('Assistant: after garbage');
});

test('recentTranscriptText rejects paths outside ~/.claude/', async () => {
	const outside = mkdtempSync(path.join(os.tmpdir(), 'expediter-outside-transcript-'));
	const outsideFile = path.join(outside, 'transcript.jsonl');
	writeFileSync(outsideFile, JSON.stringify({ type: 'user', message: { content: 'leaked' } }));
	expect(await recentTranscriptText(outsideFile)).toBeNull();
	rmSync(outside, { recursive: true, force: true });
});

// ─── Codex rollout reader (recentTranscriptText, agent-routed) ───────────────

// Codex fixtures live under ~/.codex/ to satisfy the extended containment
// check, mirroring how the Claude fixtures live under ~/.claude/. Line shapes
// are pinned verbatim from real 0.144.1 rollouts (codex-compatibility plan,
// phase 0).
function withCodexTempFile(): { file: string; done: () => void } {
	const dir = mkdtempSync(path.join(os.homedir(), '.codex', '.expediter-transcript-test-'));
	return {
		file: path.join(dir, 'rollout-test.jsonl'),
		done: () => rmSync(dir, { recursive: true, force: true })
	};
}

const codexUserLine = JSON.stringify({
	timestamp: '2026-07-14T11:42:25.000Z',
	type: 'response_item',
	payload: {
		type: 'message',
		role: 'user',
		content: [{ type: 'input_text', text: 'Run the shell command: echo hi' }]
	}
});

const codexAssistantLine = JSON.stringify({
	timestamp: '2026-07-14T11:42:31.000Z',
	type: 'response_item',
	payload: {
		type: 'message',
		role: 'assistant',
		content: [{ type: 'output_text', text: 'done' }],
		phase: 'commentary'
	}
});

test('recentTranscriptText reads codex rollout user/assistant turns', async () => {
	const t = withCodexTempFile();
	writeFileSync(
		t.file,
		[
			JSON.stringify({ type: 'session_meta', payload: { id: 'abc' } }),
			codexUserLine,
			JSON.stringify({ type: 'event_msg', payload: { type: 'token_count' } }),
			JSON.stringify({ type: 'response_item', payload: { type: 'reasoning' } }),
			codexAssistantLine
		].join('\n')
	);
	const out = await recentTranscriptText(t.file);
	expect(out).toContain('User: Run the shell command: echo hi');
	expect(out).toContain('Assistant: done');
	t.done();
});

test('recentTranscriptText skips codex function_call and event_msg lines', async () => {
	const t = withCodexTempFile();
	writeFileSync(
		t.file,
		[
			JSON.stringify({
				type: 'response_item',
				payload: { type: 'function_call', name: 'update_plan', arguments: '{}' }
			}),
			JSON.stringify({
				type: 'event_msg',
				payload: { type: 'agent_message', message: 'not a turn line' }
			})
		].join('\n')
	);
	expect(await recentTranscriptText(t.file)).toBeNull();
	t.done();
});

test('latestCustomTitle returns null quietly for a codex rollout (no custom-title lines)', async () => {
	const t = withCodexTempFile();
	writeFileSync(t.file, [codexUserLine, codexAssistantLine].join('\n'));
	expect(await latestCustomTitle(t.file)).toBeNull();
	t.done();
});

// ─── codexThreadTitle (explicit name, never prompt-backed title) ─────────────

function makeStateDb(
	rows: Array<{ id: string; title: string | null; name?: string | null }>,
	indexEntries: Array<{ id: string; thread_name: string }> = [],
	withNameColumn = true
): {
	dbPath: string;
	done: () => void;
} {
	const dir = mkdtempSync(path.join(os.tmpdir(), 'expediter-codex-db-'));
	const dbPath = path.join(dir, 'state_5.sqlite');
	const db = new Database(dbPath, { create: true });
	db.run(
		withNameColumn
			? 'CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, name TEXT, cwd TEXT, updated_at INTEGER)'
			: 'CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, cwd TEXT, updated_at INTEGER)'
	);
	for (const row of rows) {
		if (withNameColumn) {
			db.prepare(
				'INSERT INTO threads (id, title, name, cwd, updated_at) VALUES (?, ?, ?, ?, ?)'
			).run(row.id, row.title, row.name ?? null, '/tmp/x', 123);
		} else {
			db.prepare('INSERT INTO threads (id, title, cwd, updated_at) VALUES (?, ?, ?, ?)').run(
				row.id,
				row.title,
				'/tmp/x',
				123
			);
		}
	}
	db.close();
	if (indexEntries.length > 0) {
		writeFileSync(
			path.join(dir, 'session_index.jsonl'),
			indexEntries.map((entry) => JSON.stringify(entry)).join('\n')
		);
	}
	return { dbPath, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('codexThreadTitle returns threads.name and ignores raw prompt-backed title', async () => {
	const fixture = makeStateDb([
		{
			id: '019f6206-08ca-72f3-a5b6-0a427bb9848c',
			title: 'Please read this very long prompt and change many things...',
			name: 'Fix flaky boot test'
		},
		{ id: 'other-thread', title: 'Another raw prompt', name: 'Something else' }
	]);
	expect(await codexThreadTitle('019f6206-08ca-72f3-a5b6-0a427bb9848c', fixture.dbPath)).toBe(
		'Fix flaky boot test'
	);
	fixture.done();
});

test('codexThreadTitle uses the latest matching session-index name', async () => {
	const fixture = makeStateDb(
		[{ id: 'renamed', title: 'Raw first prompt', name: 'Stale db name' }],
		[
			{ id: 'renamed', thread_name: 'Old name' },
			{ id: 'other', thread_name: 'Ignore me' },
			{ id: 'renamed', thread_name: 'Current name' }
		]
	);
	expect(await codexThreadTitle('renamed', fixture.dbPath)).toBe('Current name');
	fixture.done();
});

test('codexThreadTitle supports pre-name-column databases through session_index', async () => {
	const fixture = makeStateDb(
		[{ id: 'legacy', title: 'Raw first prompt' }],
		[{ id: 'legacy', thread_name: 'Legacy rename' }],
		false
	);
	expect(await codexThreadTitle('legacy', fixture.dbPath)).toBe('Legacy rename');
	fixture.done();
});

test('codexThreadTitle never falls back to raw threads.title', async () => {
	const fixture = makeStateDb([{ id: 'unnamed', title: 'The complete user prompt', name: null }]);
	expect(await codexThreadTitle('unnamed', fixture.dbPath)).toBeNull();
	fixture.done();
});

test('codexThreadTitle returns null for a missing row', async () => {
	const fixture = makeStateDb([{ id: 'some-thread', title: 'A prompt', name: 'A name' }]);
	expect(await codexThreadTitle('not-present', fixture.dbPath)).toBeNull();
	fixture.done();
});

test('codexThreadTitle returns null when the db file is missing', async () => {
	expect(await codexThreadTitle('any-id', '/nonexistent/dir/state_5.sqlite')).toBeNull();
});

test('codexThreadTitle trims whitespace and rejects empty/null names', async () => {
	const fixture = makeStateDb([
		{ id: 'spaced', title: 'raw prompt', name: '  padded name  ' },
		{ id: 'blank', title: 'raw prompt', name: '   ' },
		{ id: 'nullish', title: 'raw prompt', name: null }
	]);
	expect(await codexThreadTitle('spaced', fixture.dbPath)).toBe('padded name');
	expect(await codexThreadTitle('blank', fixture.dbPath)).toBeNull();
	expect(await codexThreadTitle('nullish', fixture.dbPath)).toBeNull();
	fixture.done();
});

// ─── localChatTitle (per-agent title routing, plan 3.1) ──────────────────────

test('localChatTitle routes codex to its explicit name and ignores the transcript', async () => {
	const fixture = makeStateDb([
		{ id: 'route-codex', title: 'Raw prompt that must not render', name: 'Ship the adapter' }
	]);
	// transcriptPath deliberately bogus: the codex branch must never read it.
	const title = await localChatTitle(
		'codex',
		'route-codex',
		'/nonexistent/rollout.jsonl',
		fixture.dbPath
	);
	expect(title).toBe('Ship the adapter');
	fixture.done();
});

test('localChatTitle routes claude to the transcript custom-title scan', async () => {
	writeFileSync(
		transcriptFile,
		JSON.stringify({ type: 'custom-title', customTitle: 'routed claude title' })
	);
	expect(await localChatTitle('claude', 'ignored-id', transcriptFile)).toBe(
		'routed claude title'
	);
});
