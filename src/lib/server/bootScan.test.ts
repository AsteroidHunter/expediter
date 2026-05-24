import { test, expect, afterEach } from 'bun:test';
import {
	slugify,
	parsePaneRows,
	isClaudePane,
	parseSessionMeta,
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

// ─── parseSessionMeta ──────────────────────────────────────────────────────

test('parseSessionMeta extracts pid, sessionId, name, cwd', () => {
	const raw = JSON.stringify({
		pid: 97694,
		sessionId: '5ad9824d-35ad-44e8-9841-5884539420fc',
		name: 'pr-helper-3',
		cwd: '/Users/x/expediter-premain',
		status: 'idle'
	});
	const meta = parseSessionMeta(raw);
	expect(meta).toEqual({
		pid: 97694,
		sessionId: '5ad9824d-35ad-44e8-9841-5884539420fc',
		name: 'pr-helper-3',
		cwd: '/Users/x/expediter-premain'
	});
});

test('parseSessionMeta treats a missing name as empty string', () => {
	const raw = JSON.stringify({
		pid: 30366,
		sessionId: 'abc-123',
		cwd: '/some/path'
	});
	const meta = parseSessionMeta(raw);
	expect(meta?.name).toBe('');
});

test('parseSessionMeta returns null when required fields are missing', () => {
	expect(parseSessionMeta(JSON.stringify({ pid: 1 }))).toBeNull();
	expect(parseSessionMeta(JSON.stringify({ sessionId: 'x', cwd: '/y' }))).toBeNull();
	expect(parseSessionMeta(JSON.stringify({ pid: 'not-a-number', sessionId: 'x', cwd: '/y' }))).toBeNull();
});

test('parseSessionMeta returns null on malformed JSON', () => {
	expect(parseSessionMeta('not json')).toBeNull();
	expect(parseSessionMeta('[]')).toBeNull();
	expect(parseSessionMeta('null')).toBeNull();
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
