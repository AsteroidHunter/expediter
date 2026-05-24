import { test, expect, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
	slugify,
	parseName,
	parsePaneRows,
	isClaudePane,
	findSessionIdByName,
	upsertPlaceholder,
	type PaneRow
} from './bootScan';
import { list, remove } from '$lib/ticketStore';

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const fn of cleanups.splice(0)) {
		try {
			fn();
		} catch {
			/* cleanup races are harmless */
		}
	}
});

// ─── slugify ───────────────────────────────────────────────────────────────

test('slugify converts a cwd to the Claude project slug', () => {
	expect(slugify('/Users/x/foo')).toBe('-Users-x-foo');
});

test('slugify preserves a single trailing path component', () => {
	expect(slugify('/Users/x/foo/bar-baz')).toBe('-Users-x-foo-bar-baz');
});

// ─── parseName ─────────────────────────────────────────────────────────────

test('parseName extracts --name foo (space form)', () => {
	expect(parseName('claude --name foo')).toBe('foo');
});

test('parseName extracts --name=foo (equals form)', () => {
	expect(parseName('claude --name=foo')).toBe('foo');
});

test('parseName extracts a double-quoted value with spaces', () => {
	expect(parseName('claude --name "foo bar"')).toBe('foo bar');
});

test('parseName extracts a single-quoted value with spaces', () => {
	expect(parseName("claude --name 'foo bar'")).toBe('foo bar');
});

test('parseName returns null when no --name flag is present', () => {
	expect(parseName('claude --other --foo bar')).toBeNull();
});

test('parseName returns null on bare `claude`', () => {
	expect(parseName('claude')).toBeNull();
});

// ─── parsePaneRows ─────────────────────────────────────────────────────────

test('parsePaneRows handles `|`-delimited tmux output', () => {
	const stdout =
		'%1|12345|claude|/Users/x/foo\n%2|67890|bash|/Users/x/bar\n';
	const rows = parsePaneRows(stdout);
	expect(rows.length).toBe(2);
	expect(rows[0]).toEqual({
		pane_id: '%1',
		pane_pid: 12345,
		pane_current_command: 'claude',
		pane_current_path: '/Users/x/foo'
	});
	expect(rows[1].pane_current_command).toBe('bash');
});

test('parsePaneRows skips malformed rows', () => {
	const stdout = '%1|12345|claude|/Users/x/foo\nbad-row\n%2|notanint|bash|/elsewhere\n';
	const rows = parsePaneRows(stdout);
	expect(rows.length).toBe(1);
	expect(rows[0].pane_id).toBe('%1');
});

test('parsePaneRows handles trailing newline gracefully', () => {
	expect(parsePaneRows('%1|1|claude|/p\n').length).toBe(1);
});

// ─── isClaudePane ──────────────────────────────────────────────────────────

function row(cmd: string): PaneRow {
	return { pane_id: '%1', pane_pid: 1, pane_current_command: cmd, pane_current_path: '/' };
}

test('isClaudePane accepts claude and claude.exe', () => {
	expect(isClaudePane(row('claude'))).toBe(true);
	expect(isClaudePane(row('claude.exe'))).toBe(true);
});

test('isClaudePane rejects bash, vim, and look-alikes', () => {
	expect(isClaudePane(row('bash'))).toBe(false);
	expect(isClaudePane(row('vim'))).toBe(false);
	expect(isClaudePane(row('claudette'))).toBe(false);
	expect(isClaudePane(row('myclaude'))).toBe(false);
});

// ─── findSessionIdByName ───────────────────────────────────────────────────

test('findSessionIdByName matches the jsonl whose latest custom-title equals the name', async () => {
	const tempCwdParent = mkdtempSync(path.join(os.homedir(), '.claude', '.expediter-test-cwd-'));
	const projectSlug = slugify(tempCwdParent);
	const projectDir = path.join(os.homedir(), '.claude', 'projects', projectSlug);
	mkdirSync(projectDir, { recursive: true });
	cleanups.push(() => rmSync(tempCwdParent, { recursive: true, force: true }));
	cleanups.push(() => rmSync(projectDir, { recursive: true, force: true }));

	const sessionAlpha = 'aaa-111';
	const sessionBeta = 'bbb-222';
	writeFileSync(
		path.join(projectDir, `${sessionAlpha}.jsonl`),
		JSON.stringify({ type: 'custom-title', customTitle: 'alpha-task' }) + '\n'
	);
	writeFileSync(
		path.join(projectDir, `${sessionBeta}.jsonl`),
		JSON.stringify({ type: 'custom-title', customTitle: 'beta-task' }) + '\n'
	);

	const hit = await findSessionIdByName(tempCwdParent, 'beta-task');
	expect(hit?.session_id).toBe(sessionBeta);
	expect(hit?.transcript_path).toBe(path.join(projectDir, `${sessionBeta}.jsonl`));

	const miss = await findSessionIdByName(tempCwdParent, 'gamma-task');
	expect(miss).toBeNull();
});

test('findSessionIdByName returns null when the project dir does not exist', async () => {
	expect(await findSessionIdByName('/nowhere/at/all', 'whatever')).toBeNull();
});

// ─── upsertPlaceholder ─────────────────────────────────────────────────────

test('upsertPlaceholder produces a `pending:<pane>` ticket with Idle event_type', () => {
	upsertPlaceholder('%42', '/Users/x/foo');
	const ticket = list().find((t) => t.tmux_pane === '%42');
	expect(ticket?.session_id).toBe('pending:%42');
	expect(ticket?.event_type).toBe('Idle');
	expect(ticket?.cwd).toBe('/Users/x/foo');
	expect(ticket?.title).not.toBe(''); // whimsical fallback name, never empty
	remove('pending:%42');
});

test('upsertPlaceholder titles are deterministic per pane (same pane → same name)', () => {
	upsertPlaceholder('%500', '/a');
	const first = list().find((t) => t.tmux_pane === '%500')?.title;
	remove('pending:%500');
	upsertPlaceholder('%500', '/a');
	const second = list().find((t) => t.tmux_pane === '%500')?.title;
	expect(first).toBe(second);
	remove('pending:%500');
});

// Regression: when the boot scan parses --name from argv but findSessionIdByName
// returns no hit (no jsonl with a matching custom-title), the ticket must still
// show the user-supplied name rather than falling back to a whimsical stub.
test('upsertPlaceholder uses the supplied title when --name is known', () => {
	upsertPlaceholder('%501', '/users/x/proj', 'job-app-helper-1');
	const ticket = list().find((t) => t.tmux_pane === '%501');
	expect(ticket?.session_id).toBe('pending:%501');
	expect(ticket?.title).toBe('job-app-helper-1');
	remove('pending:%501');
});

test('upsertPlaceholder falls back to whimsical when title is undefined', () => {
	upsertPlaceholder('%502', '/users/x/proj', undefined);
	const ticket = list().find((t) => t.tmux_pane === '%502');
	expect(ticket?.title).not.toBe('');
	expect(ticket?.title).not.toBe('job-app-helper-1');
	remove('pending:%502');
});
