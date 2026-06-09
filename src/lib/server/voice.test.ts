import { test, expect } from 'bun:test';
import {
	parseClaudeVersion,
	versionGte,
	stopWaitMs,
	markVoiceStart,
	voiceElapsedMs,
	clearVoice,
	VOICE_STOP_FLOOR_MS
} from './voice';

// parseClaudeVersion ────────────────────────────────────────────────────────

test('parseClaudeVersion parses the standard --version line', () => {
	expect(parseClaudeVersion('2.1.154 (Claude Code)')).toEqual([2, 1, 154]);
});

test('parseClaudeVersion handles a bare version with surrounding whitespace', () => {
	expect(parseClaudeVersion('  2.1.116\n')).toEqual([2, 1, 116]);
});

test('parseClaudeVersion returns null for non-version output', () => {
	expect(parseClaudeVersion('unknown')).toBeNull();
	expect(parseClaudeVersion('')).toBeNull();
	expect(parseClaudeVersion('2.1 (x)')).toBeNull();
});

test('parseClaudeVersion returns null when a component is not numeric', () => {
	expect(parseClaudeVersion('2.x.1 (Claude Code)')).toBeNull();
});

// versionGte ────────────────────────────────────────────────────────────────

test('versionGte is true on equal versions', () => {
	expect(versionGte('2.1.116', '2.1.116')).toBe(true);
});

test('versionGte is true when newer at any component', () => {
	expect(versionGte('2.1.154', '2.1.116')).toBe(true);
	expect(versionGte('2.2.0', '2.1.116')).toBe(true);
	expect(versionGte('3.0.0', '2.1.116')).toBe(true);
});

test('versionGte is false when older at any component', () => {
	expect(versionGte('2.1.115', '2.1.116')).toBe(false);
	expect(versionGte('2.0.999', '2.1.116')).toBe(false);
	expect(versionGte('1.9.9', '2.1.116')).toBe(false);
});

test('versionGte fails closed on unparseable input', () => {
	expect(versionGte('garbage', '2.1.116')).toBe(false);
	expect(versionGte('2.1.116', 'garbage')).toBe(false);
});

// stopWaitMs ────────────────────────────────────────────────────────────────

test('stopWaitMs returns 0 when no recording is active (null elapsed)', () => {
	expect(stopWaitMs(null)).toBe(0);
});

test('stopWaitMs returns the remaining floor when released early', () => {
	expect(stopWaitMs(500, 2200)).toBe(1700);
});

test('stopWaitMs returns 0 once the floor has already passed', () => {
	expect(stopWaitMs(5000, 2200)).toBe(0);
});

test('stopWaitMs uses VOICE_STOP_FLOOR_MS by default', () => {
	expect(stopWaitMs(0)).toBe(VOICE_STOP_FLOOR_MS);
});

// active recording state (per pane) ─────────────────────────────────────────

test('voiceElapsedMs is null before start, a delta after, null after clear', () => {
	const pane = '%9001'; // unique pane id so module state doesn't leak between tests
	expect(voiceElapsedMs(pane, 1000)).toBeNull();
	markVoiceStart(pane, 1000);
	expect(voiceElapsedMs(pane, 1500)).toBe(500);
	clearVoice(pane);
	expect(voiceElapsedMs(pane, 2000)).toBeNull();
});
