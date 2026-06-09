import { test, expect } from 'bun:test';
import {
	buildBasetenUrl,
	buildBasetenMetadata,
	parseBasetenMessage,
	computeTypingDiff,
	joinTranscript
} from './basetenAdapter';

// buildBasetenUrl ───────────────────────────────────────────────────────────

test('buildBasetenUrl targets the model-specific production websocket', () => {
	expect(buildBasetenUrl('abcd1234')).toBe(
		'wss://model-abcd1234.api.baseten.co/environments/production/websocket'
	);
});

// buildBasetenMetadata ──────────────────────────────────────────────────────

test('buildBasetenMetadata declares 16kHz pcm_s16le with partials enabled', () => {
	const meta = JSON.parse(buildBasetenMetadata());
	expect(meta.streaming_params.encoding).toBe('pcm_s16le');
	expect(meta.streaming_params.sample_rate).toBe(16000);
	expect(meta.streaming_params.enable_partial_transcripts).toBe(true);
});

// parseBasetenMessage (shapes from the Baseten streaming-transcription docs) ──

test('parseBasetenMessage reads a final transcription (is_final true)', () => {
	const raw = JSON.stringify({
		type: 'transcription',
		is_final: true,
		segments: [{ text: "That's one small step for man." }]
	});
	expect(parseBasetenMessage(raw)).toEqual({ kind: 'final', text: "That's one small step for man." });
});

test('parseBasetenMessage reads a partial transcription (is_final false)', () => {
	const raw = JSON.stringify({
		type: 'transcription',
		is_final: false,
		segments: [{ text: "That's one small" }]
	});
	expect(parseBasetenMessage(raw)).toEqual({ kind: 'partial', text: "That's one small" });
});

test('parseBasetenMessage joins multiple segments and trims', () => {
	const raw = JSON.stringify({
		type: 'transcription',
		is_final: true,
		segments: [{ text: ' one ' }, { text: 'two' }]
	});
	expect(parseBasetenMessage(raw)).toEqual({ kind: 'final', text: 'one two' });
});

test('parseBasetenMessage treats a missing is_final as a partial', () => {
	const raw = JSON.stringify({ type: 'transcription', segments: [{ text: 'hi' }] });
	expect(parseBasetenMessage(raw)).toEqual({ kind: 'partial', text: 'hi' });
});

test('parseBasetenMessage recognizes the end_audio ack', () => {
	const raw = JSON.stringify({ type: 'end_audio', body: { status: 'finished' } });
	expect(parseBasetenMessage(raw)).toEqual({ kind: 'end' });
});

test('parseBasetenMessage returns other for unknown types, non-objects, and bad JSON', () => {
	expect(parseBasetenMessage(JSON.stringify({ type: 'status' })).kind).toBe('other');
	expect(parseBasetenMessage(JSON.stringify(['x'])).kind).toBe('other');
	expect(parseBasetenMessage('not json{').kind).toBe('other');
});

// computeTypingDiff ─────────────────────────────────────────────────────────

test('computeTypingDiff appends when next extends prev (no backspaces)', () => {
	expect(computeTypingDiff('', 'hello')).toEqual({ backspaces: 0, append: 'hello' });
	expect(computeTypingDiff('hello', 'hello world')).toEqual({ backspaces: 0, append: ' world' });
});

test('computeTypingDiff backspaces a deleted suffix', () => {
	expect(computeTypingDiff('hello world', 'hello')).toEqual({ backspaces: 6, append: '' });
});

test('computeTypingDiff erases past the divergence point and retypes the new suffix', () => {
	// common prefix "hel" → erase "lo" (2), type "p"
	expect(computeTypingDiff('hello', 'help')).toEqual({ backspaces: 2, append: 'p' });
});

test('computeTypingDiff is a no-op when unchanged', () => {
	expect(computeTypingDiff('abc', 'abc')).toEqual({ backspaces: 0, append: '' });
});

test('computeTypingDiff replaces everything when there is no common prefix', () => {
	expect(computeTypingDiff('abc', 'xyz')).toEqual({ backspaces: 3, append: 'xyz' });
});

// joinTranscript ────────────────────────────────────────────────────────────

test('joinTranscript returns the latest when nothing is finalized yet', () => {
	expect(joinTranscript('', 'hello there')).toBe('hello there');
});

test('joinTranscript concatenates finalized segments with a single space', () => {
	expect(joinTranscript('first sentence.', 'second one.')).toBe('first sentence. second one.');
});

test('joinTranscript trims and ignores an empty latest (keeps finalized)', () => {
	expect(joinTranscript('first.', '   ')).toBe('first.');
	expect(joinTranscript('  first.  ', 'next')).toBe('first. next');
});
