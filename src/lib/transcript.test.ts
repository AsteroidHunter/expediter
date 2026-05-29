import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { latestCustomTitle, recentTranscriptText } from './transcript';

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
