import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
	loadSessions,
	recordSession,
	forgetSession,
	pruneStaleSessions,
	type SessionEntry
} from './sessionsStore';

let tempDir = '';

beforeEach(() => {
	tempDir = mkdtempSync(path.join(os.tmpdir(), 'expediter-sessions-test-'));
	process.env.EXPEDITER_SESSIONS_FILE = path.join(tempDir, 'sessions.json');
});

afterEach(() => {
	delete process.env.EXPEDITER_SESSIONS_FILE;
	rmSync(tempDir, { recursive: true, force: true });
});

function makeEntry(session_id: string, tmux_pane: string): SessionEntry {
	return {
		session_id,
		tmux_pane,
		cwd: `/tmp/${session_id}`,
		transcript_path: `/tmp/${session_id}.jsonl`
	};
}

test('loadSessions returns {} when file is missing', async () => {
	expect(await loadSessions()).toEqual({});
});

test('recordSession + loadSessions round-trip', async () => {
	const entry = makeEntry('abc-123', '%1');
	await recordSession(entry);
	const map = await loadSessions();
	expect(map['abc-123']).toEqual(entry);
});

test('recordSession overwrites an existing entry with the same session_id', async () => {
	await recordSession(makeEntry('abc-123', '%1'));
	await recordSession({ ...makeEntry('abc-123', '%99'), cwd: '/elsewhere' });
	const map = await loadSessions();
	expect(map['abc-123']?.tmux_pane).toBe('%99');
	expect(map['abc-123']?.cwd).toBe('/elsewhere');
});

test('forgetSession removes the entry and is a no-op when absent', async () => {
	await recordSession(makeEntry('abc-123', '%1'));
	await forgetSession('abc-123');
	expect((await loadSessions())['abc-123']).toBeUndefined();
	// Calling again is harmless.
	await forgetSession('abc-123');
	expect((await loadSessions())['abc-123']).toBeUndefined();
});

test('concurrent recordSession calls do not corrupt the file (last-writer-wins)', async () => {
	const N = 20;
	const entries = Array.from({ length: N }, (_, i) =>
		makeEntry(`sess-${i}`, `%${100 + i}`)
	);
	await Promise.all(entries.map((e) => recordSession(e)));

	const sessionsFile = process.env.EXPEDITER_SESSIONS_FILE!;
	// File must remain valid JSON.
	const raw = readFileSync(sessionsFile, 'utf8');
	expect(() => JSON.parse(raw)).not.toThrow();

	// Some entries may be lost to the last-writer-wins race, but the final
	// file must at least be internally consistent (every present entry
	// matches what we tried to write).
	const map = await loadSessions();
	for (const [key, value] of Object.entries(map)) {
		const original = entries.find((e) => e.session_id === key);
		expect(original).toBeDefined();
		expect(value).toEqual(original!);
	}
});

test('pruneStaleSessions drops entries whose tmux_pane is not in the live set', async () => {
	await recordSession(makeEntry('keep-me', '%1'));
	await recordSession(makeEntry('drop-me', '%2'));
	await recordSession(makeEntry('also-keep', '%3'));

	await pruneStaleSessions(new Set(['%1', '%3']));

	const map = await loadSessions();
	expect(map['keep-me']).toBeDefined();
	expect(map['also-keep']).toBeDefined();
	expect(map['drop-me']).toBeUndefined();
});

test('pruneStaleSessions on a missing file is a no-op', async () => {
	await pruneStaleSessions(new Set(['%1']));
	expect(await loadSessions()).toEqual({});
});

test('loadSessions drops malformed per-entry shapes but keeps valid ones', async () => {
	// Hand-craft the file so a partial corruption mixes with valid entries.
	const sessionsFile = process.env.EXPEDITER_SESSIONS_FILE!;
	const dir = path.dirname(sessionsFile);
	const mixed = {
		good: { session_id: 'good', tmux_pane: '%1', cwd: '/c', transcript_path: '/t' },
		bad_missing_field: { session_id: 'x', tmux_pane: '%2' },
		bad_wrong_type: 'not-an-object'
	};
	rmSync(dir, { recursive: true, force: true });
	const { mkdirSync, writeFileSync } = await import('node:fs');
	mkdirSync(dir, { recursive: true });
	writeFileSync(sessionsFile, JSON.stringify(mixed));

	const map = await loadSessions();
	expect(map['good']).toBeDefined();
	expect(map['bad_missing_field']).toBeUndefined();
	expect(map['bad_wrong_type']).toBeUndefined();
});
