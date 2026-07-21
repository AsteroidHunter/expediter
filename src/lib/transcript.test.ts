import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Database } from 'bun:sqlite';
import {
	latestCustomTitle,
	recentTranscriptText,
	codexThreadTitle,
	localChatTitle,
	latestTurnState,
	DENIAL_PREFIX
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

// ─── codexThreadTitle (threads.title in the state db) ────────────────────────

function makeStateDb(rows: Array<{ id: string; title: string | null }>): {
	dbPath: string;
	done: () => void;
} {
	const dir = mkdtempSync(path.join(os.tmpdir(), 'expediter-codex-db-'));
	const dbPath = path.join(dir, 'state_5.sqlite');
	const db = new Database(dbPath, { create: true });
	db.run('CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, cwd TEXT, updated_at INTEGER)');
	for (const row of rows) {
		db.prepare('INSERT INTO threads (id, title, cwd, updated_at) VALUES (?, ?, ?, ?)').run(
			row.id,
			row.title,
			'/tmp/x',
			123
		);
	}
	db.close();
	return { dbPath, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('codexThreadTitle returns the thread title by session id', async () => {
	const fixture = makeStateDb([
		{ id: '019f6206-08ca-72f3-a5b6-0a427bb9848c', title: 'Fix the flaky boot test' },
		{ id: 'other-thread', title: 'Something else' }
	]);
	expect(await codexThreadTitle('019f6206-08ca-72f3-a5b6-0a427bb9848c', fixture.dbPath)).toBe(
		'Fix the flaky boot test'
	);
	fixture.done();
});

test('codexThreadTitle returns null for a missing row', async () => {
	const fixture = makeStateDb([{ id: 'some-thread', title: 'A title' }]);
	expect(await codexThreadTitle('not-present', fixture.dbPath)).toBeNull();
	fixture.done();
});

test('codexThreadTitle returns null when the db file is missing', async () => {
	expect(await codexThreadTitle('any-id', '/nonexistent/dir/state_5.sqlite')).toBeNull();
});

test('codexThreadTitle trims whitespace and rejects empty/null titles', async () => {
	const fixture = makeStateDb([
		{ id: 'spaced', title: '  padded title  ' },
		{ id: 'blank', title: '   ' },
		{ id: 'nullish', title: null }
	]);
	expect(await codexThreadTitle('spaced', fixture.dbPath)).toBe('padded title');
	expect(await codexThreadTitle('blank', fixture.dbPath)).toBeNull();
	expect(await codexThreadTitle('nullish', fixture.dbPath)).toBeNull();
	fixture.done();
});

// ─── localChatTitle (per-agent title routing, plan 3.1) ──────────────────────

test('localChatTitle routes codex to the state db and ignores the transcript', async () => {
	const fixture = makeStateDb([{ id: 'route-codex', title: 'Ship the adapter' }]);
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

// ─── latestTurnState (boot working recovery) ─────────────────────────────────

// Line shapes pinned from live transcripts: an in-flight claude session ends
// with a user line (prompt or tool_result) or an assistant line ending in
// tool_use; an at-rest one ends with a text-only assistant line.

const userPrompt = JSON.stringify({ type: 'user', message: { content: 'fix the bug' } });
const assistantText = JSON.stringify({
	type: 'assistant',
	message: { content: [{ type: 'text', text: 'done, here is the summary' }] }
});
const assistantToolUse = JSON.stringify({
	type: 'assistant',
	message: {
		content: [
			{ type: 'text', text: 'running it now' },
			{ type: 'tool_use', name: 'Bash' }
		]
	}
});
const toolResultOk = JSON.stringify({
	type: 'user',
	message: { content: [{ type: 'tool_result', content: 'exit 0' }] }
});

test('latestTurnState: trailing user prompt is in-flight (claude)', async () => {
	writeFileSync(transcriptFile, [assistantText, userPrompt].join('\n'));
	expect(await latestTurnState('claude', transcriptFile)).toBe('in-flight');
});

test('latestTurnState: trailing tool_result is in-flight (claude)', async () => {
	writeFileSync(transcriptFile, [userPrompt, assistantToolUse, toolResultOk].join('\n'));
	expect(await latestTurnState('claude', transcriptFile)).toBe('in-flight');
});

test('latestTurnState: trailing assistant ending in tool_use is in-flight (claude)', async () => {
	writeFileSync(transcriptFile, [userPrompt, assistantToolUse].join('\n'));
	expect(await latestTurnState('claude', transcriptFile)).toBe('in-flight');
});

test('latestTurnState: trailing text-only assistant is rest (claude)', async () => {
	writeFileSync(transcriptFile, [userPrompt, assistantToolUse, toolResultOk, assistantText].join('\n'));
	expect(await latestTurnState('claude', transcriptFile)).toBe('rest');
});

test('latestTurnState: Esc-interrupt marker on a user line is rest (claude)', async () => {
	const interrupted = JSON.stringify({
		type: 'user',
		message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] }
	});
	writeFileSync(transcriptFile, [userPrompt, interrupted].join('\n'));
	expect(await latestTurnState('claude', transcriptFile)).toBe('rest');

	const interruptedString = JSON.stringify({
		type: 'user',
		message: { content: '[Request interrupted by user for tool use]' }
	});
	writeFileSync(transcriptFile, [userPrompt, interruptedString].join('\n'));
	expect(await latestTurnState('claude', transcriptFile)).toBe('rest');
});

test('latestTurnState: permission-denial tool_result is rest (claude)', async () => {
	const denial = JSON.stringify({
		type: 'user',
		message: {
			content: [
				{
					type: 'tool_result',
					is_error: true,
					content: `${DENIAL_PREFIX}. The tool use was rejected.`
				}
			]
		}
	});
	writeFileSync(transcriptFile, [userPrompt, assistantToolUse, denial].join('\n'));
	expect(await latestTurnState('claude', transcriptFile)).toBe('rest');
});

test('latestTurnState: a failed (is_error) tool_result without the denial prefix is in-flight', async () => {
	const failedTool = JSON.stringify({
		type: 'user',
		message: {
			content: [{ type: 'tool_result', is_error: true, content: 'command exited 1' }]
		}
	});
	writeFileSync(transcriptFile, [userPrompt, assistantToolUse, failedTool].join('\n'));
	expect(await latestTurnState('claude', transcriptFile)).toBe('in-flight');
});

test('latestTurnState: skips isMeta and metadata lines and decides on the line before them', async () => {
	const metaLine = JSON.stringify({
		type: 'user',
		isMeta: true,
		message: { content: [{ type: 'text', text: 'Base directory for this skill: /x' }] }
	});
	const titleLine = JSON.stringify({ type: 'custom-title', customTitle: 'whatever' });
	writeFileSync(transcriptFile, [userPrompt, assistantText, metaLine, titleLine].join('\n'));
	expect(await latestTurnState('claude', transcriptFile)).toBe('rest');
});

test('latestTurnState: null for a missing, empty, or message-free file', async () => {
	expect(await latestTurnState('claude', path.join(tempDir, 'missing.jsonl'))).toBeNull();
	writeFileSync(transcriptFile, '');
	expect(await latestTurnState('claude', transcriptFile)).toBeNull();
	writeFileSync(transcriptFile, JSON.stringify({ type: 'custom-title', customTitle: 'x' }));
	expect(await latestTurnState('claude', transcriptFile)).toBeNull();
});

test('latestTurnState: rejects paths outside the containment roots', async () => {
	const outside = mkdtempSync(path.join(os.tmpdir(), 'expediter-outside-turnstate-'));
	const outsideFile = path.join(outside, 'transcript.jsonl');
	writeFileSync(outsideFile, userPrompt);
	expect(await latestTurnState('claude', outsideFile)).toBeNull();
	rmSync(outside, { recursive: true, force: true });
});

// Codex: the newest task lifecycle event decides (shapes pinned on 0.144.1).

const codexTaskStarted = JSON.stringify({
	type: 'event_msg',
	payload: { type: 'task_started', model_context_window: 258400 }
});
const codexTaskComplete = JSON.stringify({
	type: 'event_msg',
	payload: { type: 'task_complete', last_agent_message: 'done' }
});
const codexTurnAborted = JSON.stringify({
	type: 'event_msg',
	payload: { type: 'turn_aborted', reason: 'interrupted' }
});

test('latestTurnState: codex task_started with no later end marker is in-flight', async () => {
	const t = withCodexTempFile();
	writeFileSync(
		t.file,
		[codexTaskStarted, codexUserLine, JSON.stringify({ type: 'event_msg', payload: { type: 'token_count' } })].join('\n')
	);
	expect(await latestTurnState('codex', t.file)).toBe('in-flight');
	t.done();
});

test('latestTurnState: codex task_complete after task_started is rest', async () => {
	const t = withCodexTempFile();
	writeFileSync(t.file, [codexTaskStarted, codexAssistantLine, codexTaskComplete].join('\n'));
	expect(await latestTurnState('codex', t.file)).toBe('rest');
	t.done();
});

test('latestTurnState: codex turn_aborted is rest', async () => {
	const t = withCodexTempFile();
	writeFileSync(t.file, [codexTaskStarted, codexTurnAborted].join('\n'));
	expect(await latestTurnState('codex', t.file)).toBe('rest');
	t.done();
});

test('latestTurnState: codex rollout with no lifecycle events is null', async () => {
	const t = withCodexTempFile();
	writeFileSync(t.file, [codexUserLine, codexAssistantLine].join('\n'));
	expect(await latestTurnState('codex', t.file)).toBeNull();
	t.done();
});
