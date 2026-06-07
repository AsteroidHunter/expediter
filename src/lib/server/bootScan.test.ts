import { test, expect, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
	slugify,
	parsePaneRows,
	isClaudePane,
	parseSessionMeta,
	upsertPlaceholder,
	runBootScan,
	reconcile,
	startReconcilePoll,
	type PaneRow,
	type BootScanDeps
} from './bootScan';
import { recordSession } from './sessionsStore';
import { list, remove, upsert, markWorking } from '$lib/ticketStore';

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

test('parsePaneRows handles `|`-delimited tmux output (attached col before cwd)', () => {
	const stdout =
		'%1|12345|claude|1|/Users/x/foo\n%2|67890|bash|0|/Users/x/bar\n';
	const rows = parsePaneRows(stdout);
	expect(rows.length).toBe(2);
	expect(rows[0]).toEqual({
		pane_id: '%1',
		pane_pid: 12345,
		pane_current_command: 'claude',
		pane_current_path: '/Users/x/foo',
		session_attached: true
	});
	expect(rows[1].pane_current_command).toBe('bash');
	expect(rows[1].session_attached).toBe(false);
});

test('parsePaneRows treats a multi-client session (attached=2) as attached', () => {
	const rows = parsePaneRows('%1|1|claude|2|/p\n');
	expect(rows[0].session_attached).toBe(true);
});

test('parsePaneRows preserves a cwd containing a pipe character', () => {
	const rows = parsePaneRows('%1|1|claude|1|/Users/x/a|b\n');
	expect(rows.length).toBe(1);
	expect(rows[0].pane_current_path).toBe('/Users/x/a|b');
	expect(rows[0].session_attached).toBe(true);
});

test('parsePaneRows skips malformed rows', () => {
	const stdout = '%1|12345|claude|1|/Users/x/foo\nbad-row\n%2|notanint|bash|0|/elsewhere\n';
	const rows = parsePaneRows(stdout);
	expect(rows.length).toBe(1);
	expect(rows[0].pane_id).toBe('%1');
});

test('parsePaneRows handles trailing newline gracefully', () => {
	expect(parsePaneRows('%1|1|claude|1|/p\n').length).toBe(1);
});

// ─── isClaudePane ──────────────────────────────────────────────────────────

function row(cmd: string): PaneRow {
	return {
		pane_id: '%1',
		pane_pid: 1,
		pane_current_command: cmd,
		pane_current_path: '/',
		session_attached: true
	};
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

// ─── runBootScan ordering ──────────────────────────────────────────────────

function pane(pane_id: string, pane_pid: number, cwd: string, attached = true): PaneRow {
	return {
		pane_id,
		pane_pid,
		pane_current_command: 'claude',
		pane_current_path: cwd,
		session_attached: attached
	};
}

function useTempSessionsFile(): void {
	const dir = mkdtempSync(path.join(os.tmpdir(), 'expediter-bootscan-'));
	process.env.EXPEDITER_SESSIONS_FILE = path.join(dir, 'sessions.json');
	cleanups.push(() => {
		delete process.env.EXPEDITER_SESSIONS_FILE;
		rmSync(dir, { recursive: true, force: true });
	});
}

// Regression for the ghost-ticket bug: a persisted entry left behind when a
// claude exited without SessionEnd (pane still alive) must NOT mask the live
// session now running in that pane. The live metadata file wins; the dock
// ticket is keyed by the live session_id so hook events can find it.
test('runBootScan prefers live metadata over a stale persisted entry for the same pane', async () => {
	useTempSessionsFile();
	cleanups.push(() => {
		remove('live-session');
		remove('dead-session');
		remove('pending:%86');
	});

	await recordSession({
		session_id: 'dead-session',
		tmux_pane: '%86',
		cwd: '/Users/x/proj',
		transcript_path: '/Users/x/proj/dead.jsonl'
	});

	const deps: BootScanDeps = {
		listPanes: async () => [pane('%86', 17071, '/Users/x/proj')],
		readSessionMetas: async () => [
			{ pid: 92388, sessionId: 'live-session', name: 'autospawn-tickets-5', cwd: '/Users/x/proj' }
		],
		parentPid: async (pid) => (pid === 92388 ? 17071 : null)
	};

	await runBootScan(deps);

	const ticket = list().find((t) => t.tmux_pane === '%86');
	expect(ticket?.session_id).toBe('live-session');
	expect(ticket?.title).toBe('autospawn-tickets-5');
	expect(list().find((t) => t.session_id === 'dead-session')).toBeUndefined();
});

test('runBootScan falls back to the persisted entry when no metadata matches the pane', async () => {
	useTempSessionsFile();
	cleanups.push(() => {
		remove('persisted-session');
		remove('pending:%50');
	});

	await recordSession({
		session_id: 'persisted-session',
		tmux_pane: '%50',
		cwd: '/p',
		transcript_path: '/p/x.jsonl'
	});

	const deps: BootScanDeps = {
		listPanes: async () => [pane('%50', 5000, '/p')],
		readSessionMetas: async () => [],
		parentPid: async () => null
	};

	await runBootScan(deps);

	expect(list().find((t) => t.tmux_pane === '%50')?.session_id).toBe('persisted-session');
});

test('runBootScan seeds a placeholder when neither metadata nor persistence matches', async () => {
	useTempSessionsFile();
	cleanups.push(() => remove('pending:%99'));

	const deps: BootScanDeps = {
		listPanes: async () => [pane('%99', 9999, '/q')],
		readSessionMetas: async () => [],
		parentPid: async () => null
	};

	await runBootScan(deps);

	expect(list().find((t) => t.tmux_pane === '%99')?.session_id).toBe('pending:%99');
});

// Runtime detach awareness: a detached pane is now SEEDED as a detached ticket
// (attached:false), not skipped; an attached pane in the same scan is seeded
// attached:true. (Flipped from the old boot-time-snapshot behavior that dropped
// detached panes entirely.)
test('runBootScan seeds detached panes as detached, attached as attached', async () => {
	useTempSessionsFile();
	cleanups.push(() => {
		remove('attached-sess');
		remove('detached-sess');
		remove('pending:%10');
		remove('pending:%11');
	});

	const deps: BootScanDeps = {
		listPanes: async () => [
			pane('%10', 1000, '/a', true),
			pane('%11', 1100, '/b', false)
		],
		readSessionMetas: async () => [
			{ pid: 2000, sessionId: 'attached-sess', name: 'attached', cwd: '/a' },
			{ pid: 2100, sessionId: 'detached-sess', name: 'detached', cwd: '/b' }
		],
		parentPid: async (pid) => (pid === 2000 ? 1000 : pid === 2100 ? 1100 : null)
	};

	await runBootScan(deps);

	const attached = list().find((t) => t.tmux_pane === '%10');
	const detached = list().find((t) => t.tmux_pane === '%11');
	expect(attached?.session_id).toBe('attached-sess');
	expect(attached?.attached).toBe(true);
	expect(detached?.session_id).toBe('detached-sess');
	expect(detached?.attached).toBe(false);
});

// A detached ticket flips back to attached when a later reconcile sees the
// session re-attached — without being dropped or re-seeded in between.
test('reconcile flips a detached ticket back to attached on re-attach', async () => {
	useTempSessionsFile();
	cleanups.push(() => {
		remove('flip-sess');
		remove('pending:%12');
	});

	const readSessionMetas = async () => [
		{ pid: 3000, sessionId: 'flip-sess', name: 'flip', cwd: '/a' }
	];
	const parentPid = async (pid: number) => (pid === 3000 ? 1200 : null);

	await runBootScan({
		listPanes: async () => [pane('%12', 1200, '/a', false)],
		readSessionMetas,
		parentPid
	});
	expect(list().find((t) => t.session_id === 'flip-sess')?.attached).toBe(false);

	await runBootScan({
		listPanes: async () => [pane('%12', 1200, '/a', true)],
		readSessionMetas,
		parentPid
	});
	const t = list().find((x) => x.session_id === 'flip-sess');
	expect(t?.attached).toBe(true);
	expect(t?.event_type).toBe('Idle'); // preserved, not re-seeded
});

// A full reconcile GCs a ticket whose pane has vanished (claude exited / pane
// died with no SessionEnd). The created_at guard only spares tickets younger
// than the scan, so a pre-existing dead-pane ticket is removed.
test('reconcile GCs a ticket whose pane is gone', async () => {
	useTempSessionsFile();
	cleanups.push(() => remove('gone-sess'));

	upsert({
		session_id: 'gone-sess',
		tmux_pane: '%77',
		cwd: '/a',
		title: 'gone',
		event_type: 'Stop',
		created_at: Date.now() - 10_000 // predates the scan start → eligible for GC
	});
	expect(list().find((t) => t.session_id === 'gone-sess')).toBeDefined();

	await runBootScan({
		listPanes: async () => [],
		readSessionMetas: async () => [],
		parentPid: async () => null
	});

	expect(list().find((t) => t.session_id === 'gone-sess')).toBeUndefined();
});

// The load-bearing invariant: a full reconcile must not disturb a live ticket's
// event_type / working / title. It only refreshes the attach flag. A working
// PermissionRequest ticket whose pane is still live survives untouched.
test('reconcile preserves a live working ticket, updating only the attach flag', async () => {
	useTempSessionsFile();
	cleanups.push(() => remove('live-work'));

	upsert({
		session_id: 'live-work',
		tmux_pane: '%88',
		cwd: '/a',
		title: 'busy session',
		event_type: 'PermissionRequest',
		created_at: Date.now()
	});
	markWorking('live-work'); // working=true, event_type stays PermissionRequest

	// Pane still live, now reported detached → only the attach flag should move.
	await runBootScan({
		listPanes: async () => [pane('%88', 8800, '/a', false)],
		readSessionMetas: async () => [],
		parentPid: async () => null
	});

	const t = list().find((x) => x.session_id === 'live-work');
	expect(t?.working).toBe(true);
	expect(t?.event_type).toBe('PermissionRequest');
	expect(t?.title).toBe('busy session');
	expect(t?.attached).toBe(false);
});

// The light path (tmux-hook trigger) flips attach flags on existing tickets but
// never seeds a new pane and never GCs a vanished one — that is the full path's
// job. A brand-new claude pane in the snapshot is ignored; an existing ticket
// whose pane is absent is left alone; a present ticket's flag flips.
test('reconcile light mode flips flags without seeding or GC', async () => {
	useTempSessionsFile();
	cleanups.push(() => {
		remove('present-sess');
		remove('absent-sess');
	});

	upsert({ session_id: 'present-sess', tmux_pane: '%90', cwd: '/a', title: 't', event_type: 'Stop', created_at: Date.now() });
	upsert({ session_id: 'absent-sess', tmux_pane: '%91', cwd: '/b', title: 't', event_type: 'Stop', created_at: Date.now() - 10_000 });

	await reconcile(
		{
			listPanes: async () => [
				pane('%90', 9000, '/a', false), // present ticket → flag flips to detached
				pane('%92', 9200, '/c', true) // brand-new claude pane → must NOT be seeded
			],
			readSessionMetas: async () => [],
			parentPid: async () => null
		},
		'light'
	);

	expect(list().find((t) => t.session_id === 'present-sess')?.attached).toBe(false); // flipped
	expect(list().find((t) => t.session_id === 'absent-sess')).toBeDefined(); // NOT GC'd
	expect(list().find((t) => t.tmux_pane === '%92')).toBeUndefined(); // NOT seeded
});

// ─── slow poll ───────────────────────────────────────────────────────────────

// Polls a predicate until true or timeout, so the interval-driven poll test
// doesn't couple to exact setInterval timing.
async function waitFor(pred: () => boolean, timeoutMs = 500): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (pred()) return;
		await new Promise((r) => setTimeout(r, 5));
	}
	if (!pred()) throw new Error('waitFor timed out');
}

test('startReconcilePoll reflects a simulated detach after a tick', async () => {
	useTempSessionsFile();
	cleanups.push(() => remove('poll-sess'));

	let attached = true;
	const deps: BootScanDeps = {
		listPanes: async () => [pane('%55', 5500, '/a', attached)],
		readSessionMetas: async () => [{ pid: 5501, sessionId: 'poll-sess', name: 'poll', cwd: '/a' }],
		parentPid: async (pid) => (pid === 5501 ? 5500 : null)
	};

	await runBootScan(deps); // initial full reconcile → attached
	expect(list().find((t) => t.session_id === 'poll-sess')?.attached).toBe(true);

	attached = false; // simulate a detach between ticks
	const timer = startReconcilePoll(deps, 15);
	cleanups.push(() => clearInterval(timer));

	await waitFor(() => list().find((t) => t.session_id === 'poll-sess')?.attached === false);
	expect(list().find((t) => t.session_id === 'poll-sess')?.attached).toBe(false);
});

// ─── tmux-hook (light) multi-client semantics ────────────────────────────────

// tmux #{session_attached} is a CLIENT COUNT, mapped to a boolean by
// parsePaneRows (count > 0), so a multi-client session stays attached until the
// LAST client detaches. Exercised through the light path the tmux hook drives:
// the pane reports attached while any client remains, detached only at zero.
test('light reconcile keeps a multi-client session attached until the last client detaches', async () => {
	useTempSessionsFile();
	cleanups.push(() => remove('multi-sess'));

	upsert({ session_id: 'multi-sess', tmux_pane: '%66', cwd: '/a', title: 't', event_type: 'Stop', created_at: Date.now() });

	const lightWith = (attached: boolean) =>
		reconcile(
			{
				listPanes: async () => [pane('%66', 6600, '/a', attached)],
				readSessionMetas: async () => [],
				parentPid: async () => null
			},
			'light'
		);

	await lightWith(true); // 2 clients (count 2 → true): attached
	expect(list().find((t) => t.session_id === 'multi-sess')?.attached).toBe(true);

	await lightWith(true); // 1 client remaining (count 1 → true): still attached
	expect(list().find((t) => t.session_id === 'multi-sess')?.attached).toBe(true);

	await lightWith(false); // last client gone (count 0 → false): detached
	expect(list().find((t) => t.session_id === 'multi-sess')?.attached).toBe(false);
});
