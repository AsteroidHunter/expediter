import { test, expect, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
	slugify,
	parsePaneRows,
	paneAgent,
	isLocalAgentPane,
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

// ─── paneAgent / isLocalAgentPane ──────────────────────────────────────────

function row(cmd: string): PaneRow {
	return {
		pane_id: '%1',
		pane_pid: 1,
		pane_current_command: cmd,
		pane_current_path: '/',
		session_attached: true
	};
}

test('paneAgent classifies claude and codex panes', () => {
	expect(paneAgent(row('claude'))).toBe('claude');
	expect(paneAgent(row('claude.exe'))).toBe('claude');
	expect(paneAgent(row('codex'))).toBe('codex');
	expect(paneAgent(row('codex.exe'))).toBe('codex');
});

test('paneAgent rejects bash, vim, and look-alikes', () => {
	expect(paneAgent(row('bash'))).toBeNull();
	expect(paneAgent(row('vim'))).toBeNull();
	expect(paneAgent(row('claudette'))).toBeNull();
	expect(paneAgent(row('myclaude'))).toBeNull();
	expect(paneAgent(row('codexx'))).toBeNull();
});

test('isLocalAgentPane covers both agents and rejects everything else', () => {
	expect(isLocalAgentPane(row('claude'))).toBe(true);
	expect(isLocalAgentPane(row('codex'))).toBe(true);
	expect(isLocalAgentPane(row('ssh'))).toBe(false);
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

test('runBootScan falls back to a pid-valid persisted entry when no metadata matches the pane', async () => {
	useTempSessionsFile();
	cleanups.push(() => {
		remove('persisted-session');
		remove('pending:%50');
	});

	await recordSession({
		session_id: 'persisted-session',
		tmux_pane: '%50',
		cwd: '/p',
		transcript_path: '/p/x.jsonl',
		agent_pid: 5001
	});

	const deps: BootScanDeps = {
		listPanes: async () => [pane('%50', 5000, '/p')],
		readSessionMetas: async () => [],
		// The recorded agent pid is alive and still a child of the pane shell.
		parentPid: async (pid) => (pid === 5001 ? 5000 : null)
	};

	await runBootScan(deps);

	expect(list().find((t) => t.tmux_pane === '%50')?.session_id).toBe('persisted-session');
});

// ─── agent_pid boot guard (local entries only) ──────────────────────────────

// A persisted local entry whose agent_pid is DEAD (parentPid → null) must not
// reclaim the pane: the process was replaced, so the identity is stale. The
// pane degrades to a placeholder that the next hook event rekeys.
test('runBootScan rejects a persisted entry whose agent_pid is dead', async () => {
	useTempSessionsFile();
	cleanups.push(() => {
		remove('dead-pid-session');
		remove('pending:%51');
	});

	await recordSession({
		session_id: 'dead-pid-session',
		tmux_pane: '%51',
		cwd: '/p',
		transcript_path: '/p/x.jsonl',
		agent_pid: 5101
	});

	await runBootScan({
		listPanes: async () => [pane('%51', 5100, '/p')],
		readSessionMetas: async () => [],
		parentPid: async () => null // pid is gone
	});

	const ticket = list().find((t) => t.tmux_pane === '%51');
	expect(ticket?.session_id).toBe('pending:%51');
	expect(list().find((t) => t.session_id === 'dead-pid-session')).toBeUndefined();
});

// Same-pane-process-replaced: the pid is alive but reparented (a NEW agent
// process owns the pane's shell now — parentPid returns a different shell).
test('runBootScan rejects a persisted entry whose agent_pid moved to another pane', async () => {
	useTempSessionsFile();
	cleanups.push(() => {
		remove('moved-pid-session');
		remove('pending:%52');
	});

	await recordSession({
		session_id: 'moved-pid-session',
		tmux_pane: '%52',
		cwd: '/p',
		transcript_path: '/p/x.jsonl',
		agent_pid: 5201
	});

	await runBootScan({
		listPanes: async () => [pane('%52', 5200, '/p')],
		readSessionMetas: async () => [],
		parentPid: async (pid) => (pid === 5201 ? 9999 : null) // alive, different shell
	});

	expect(list().find((t) => t.tmux_pane === '%52')?.session_id).toBe('pending:%52');
});

// An entry written before the agent_pid field existed (or whose resolution
// failed at SessionStart) is unverifiable — fail toward the placeholder.
test('runBootScan rejects a persisted entry with no agent_pid recorded', async () => {
	useTempSessionsFile();
	cleanups.push(() => {
		remove('no-pid-session');
		remove('pending:%53');
	});

	await recordSession({
		session_id: 'no-pid-session',
		tmux_pane: '%53',
		cwd: '/p',
		transcript_path: '/p/x.jsonl'
	});

	await runBootScan({
		listPanes: async () => [pane('%53', 5300, '/p')],
		readSessionMetas: async () => [],
		parentPid: async () => 5300 // would validate any pid — but there is none to check
	});

	expect(list().find((t) => t.tmux_pane === '%53')?.session_id).toBe('pending:%53');
});

// ─── codex panes (local-agent set) ──────────────────────────────────────────

function codexPane(pane_id: string, pane_pid: number, cwd: string, attached = true): PaneRow {
	return {
		pane_id,
		pane_pid,
		pane_current_command: 'codex',
		pane_current_path: cwd,
		session_attached: attached
	};
}

// A codex pane with no metadata (codex writes none) and no persisted entry
// seeds the same pending: placeholder a claude pane would — stamped codex.
test('runBootScan seeds a codex placeholder for a bare codex pane', async () => {
	useTempSessionsFile();
	cleanups.push(() => remove('pending:%60'));

	await runBootScan({
		listPanes: async () => [codexPane('%60', 6000, '/q')],
		readSessionMetas: async () => [],
		parentPid: async () => null
	});

	const ticket = list().find((t) => t.tmux_pane === '%60');
	expect(ticket?.session_id).toBe('pending:%60');
	expect(ticket?.agent).toBe('codex');
});

// A pid-valid persisted codex entry reclaims its pane at boot, with the agent
// re-derived from the stored transcript_path's /.codex/ segment.
test('runBootScan reseeds a pid-valid codex entry with agent codex', async () => {
	useTempSessionsFile();
	cleanups.push(() => {
		remove('codex-session');
		remove('pending:%61');
	});

	await recordSession({
		session_id: 'codex-session',
		tmux_pane: '%61',
		cwd: '/q',
		transcript_path: path.join(os.homedir(), '.codex/sessions/2026/07/14/rollout-x.jsonl'),
		agent_pid: 6101
	});

	await runBootScan({
		listPanes: async () => [codexPane('%61', 6100, '/q')],
		readSessionMetas: async () => [],
		parentPid: async (pid) => (pid === 6101 ? 6100 : null)
	});

	const ticket = list().find((t) => t.tmux_pane === '%61');
	expect(ticket?.session_id).toBe('codex-session');
	expect(ticket?.agent).toBe('codex');
});

// The local GC rule covers codex panes: a codex ticket whose pane stopped
// running codex (agent exited, shell remains) is reaped like a claude one.
test('reconcile GCs a codex ticket whose pane no longer runs an agent', async () => {
	useTempSessionsFile();
	cleanups.push(() => remove('codex-gone'));

	upsert({
		session_id: 'codex-gone',
		tmux_pane: '%62',
		cwd: '/q',
		title: 'codex work',
		event_type: 'Stop',
		created_at: Date.now() - 10_000,
		agent: 'codex'
	});

	await runBootScan({
		listPanes: async () => [
			{
				pane_id: '%62',
				pane_pid: 6200,
				pane_current_command: 'zsh', // codex exited; bare shell remains
				pane_current_path: '/q',
				session_attached: true
			}
		],
		readSessionMetas: async () => [],
		parentPid: async () => null
	});

	expect(list().find((t) => t.session_id === 'codex-gone')).toBeUndefined();
});

// Claude metadata files never hijack a codex pane: the metadata branch is
// claude-only, so a codex pane whose shell pid collides with a claude meta's
// parent still goes to its own persisted entry / placeholder.
test('runBootScan does not apply claude metadata to a codex pane', async () => {
	useTempSessionsFile();
	cleanups.push(() => remove('pending:%63'));

	await runBootScan({
		listPanes: async () => [codexPane('%63', 6300, '/q')],
		readSessionMetas: async () => [
			{ pid: 6301, sessionId: 'claude-meta-session', name: 'claude thing', cwd: '/q' }
		],
		parentPid: async (pid) => (pid === 6301 ? 6300 : null) // maps onto the codex pane's shell
	});

	const ticket = list().find((t) => t.tmux_pane === '%63');
	expect(ticket?.session_id).toBe('pending:%63');
	expect(ticket?.agent).toBe('codex');
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

// ─── remote tickets (lifecycle rules differ from local) ─────────────────────

// A remote ticket's local pane runs `ssh`, never claude.
function sshPane(pane_id: string, pane_pid: number, attached = true): PaneRow {
	return {
		pane_id,
		pane_pid,
		pane_current_command: 'ssh',
		pane_current_path: '/Users/x',
		session_attached: attached
	};
}

// The rule that kills the reap-flicker: a remote ticket survives the GC while
// its ssh pane exists, even though that pane never runs claude — while a
// LOCAL ticket on the same kind of pane is reaped by the claude-pane rule.
test('reconcile spares a remote ticket on a live ssh pane and reaps a local one', async () => {
	useTempSessionsFile();
	cleanups.push(() => {
		remove('remote-sess');
		remove('local-stale');
	});

	upsert({
		session_id: 'remote-sess',
		tmux_pane: '%70',
		cwd: '/remote/proj',
		title: 'gpu box',
		event_type: 'Stop',
		created_at: Date.now() - 10_000,
		remote: true
	});
	upsert({
		session_id: 'local-stale',
		tmux_pane: '%71',
		cwd: '/local/proj',
		title: 'dead local',
		event_type: 'Stop',
		created_at: Date.now() - 10_000
	});

	await runBootScan({
		listPanes: async () => [sshPane('%70', 7000), sshPane('%71', 7100)],
		readSessionMetas: async () => [],
		parentPid: async () => null
	});

	expect(list().find((t) => t.session_id === 'remote-sess')).toBeDefined();
	expect(list().find((t) => t.session_id === 'local-stale')).toBeUndefined();
});

test('reconcile reaps a remote ticket once its ssh pane is gone', async () => {
	useTempSessionsFile();
	cleanups.push(() => remove('remote-gone'));

	upsert({
		session_id: 'remote-gone',
		tmux_pane: '%75',
		cwd: '/remote/proj',
		title: 'gone box',
		event_type: 'Stop',
		created_at: Date.now() - 10_000,
		remote: true
	});

	await runBootScan({
		listPanes: async () => [],
		readSessionMetas: async () => [],
		parentPid: async () => null
	});

	expect(list().find((t) => t.session_id === 'remote-gone')).toBeUndefined();
});

// Boot reseed (decisions 6+13): a persisted remote entry whose ssh pane
// survived the daemon restart comes back as an Idle ticket with the persisted
// title and the pane row's attach state. A non-claude pane with NO remote
// history gets nothing — pending: placeholders are for claude panes only.
test('runBootScan reseeds a persisted remote session with its title; no placeholder for bare panes', async () => {
	useTempSessionsFile();
	cleanups.push(() => {
		remove('remote-reseed');
		remove('pending:%81');
	});

	await recordSession({
		session_id: 'remote-reseed',
		tmux_pane: '%80',
		cwd: '/remote/proj',
		transcript_path: '/remote/home/u/.claude/projects/x/t.jsonl',
		remote: true,
		title: 'gpu box refactor'
	});

	await runBootScan({
		listPanes: async () => [sshPane('%80', 8000, false), sshPane('%81', 8100)],
		readSessionMetas: async () => [],
		parentPid: async () => null
	});

	const t = list().find((x) => x.session_id === 'remote-reseed');
	expect(t).toBeDefined();
	expect(t?.event_type).toBe('Idle');
	expect(t?.remote).toBe(true);
	expect(t?.title).toBe('gpu box refactor');
	expect(t?.attached).toBe(false); // pane row said detached
	expect(list().find((x) => x.tmux_pane === '%81')).toBeUndefined(); // no placeholder
});

test('a reseeded remote entry without a persisted title falls back to a whimsical name', async () => {
	useTempSessionsFile();
	cleanups.push(() => remove('remote-untitled'));

	await recordSession({
		session_id: 'remote-untitled',
		tmux_pane: '%82',
		cwd: '/remote/proj',
		transcript_path: '/remote/t.jsonl',
		remote: true
	});

	await runBootScan({
		listPanes: async () => [sshPane('%82', 8200)],
		readSessionMetas: async () => [],
		parentPid: async () => null
	});

	const t = list().find((x) => x.session_id === 'remote-untitled');
	expect(t?.remote).toBe(true);
	expect(t?.title).not.toBe(''); // never blank
});

// ─── remote-tmux siblings (uniqueness cell, D4/D8) ──────────────────────────

// Boot reseed recreates one ticket PER SIBLING: two persisted remote-tmux
// entries share the ssh pane %85 but differ in remote_pane, and both must
// come back with their far pane and title intact — the pre-cell pane-wide
// guard would have collapsed them to whichever entry iterated first.
test('runBootScan reseeds every persisted sibling on one ssh pane, remote_pane intact', async () => {
	useTempSessionsFile();
	cleanups.push(() => {
		remove('sib-reseed-a');
		remove('sib-reseed-b');
	});

	await recordSession({
		session_id: 'sib-reseed-a',
		tmux_pane: '%85',
		cwd: '/remote/proj',
		transcript_path: '/remote/home/u/.claude/projects/x/a.jsonl',
		remote: true,
		remote_pane: '%3',
		title: 'sibling A'
	});
	await recordSession({
		session_id: 'sib-reseed-b',
		tmux_pane: '%85',
		cwd: '/remote/proj',
		transcript_path: '/remote/home/u/.codex/sessions/2026/07/23/rollout-b.jsonl',
		remote: true,
		remote_pane: '%7',
		title: 'sibling B'
	});

	await runBootScan({
		listPanes: async () => [sshPane('%85', 8500)],
		readSessionMetas: async () => [],
		parentPid: async () => null
	});

	const a = list().find((x) => x.session_id === 'sib-reseed-a');
	const b = list().find((x) => x.session_id === 'sib-reseed-b');
	expect(a).toBeDefined();
	expect(b).toBeDefined();
	expect(a?.remote_pane).toBe('%3');
	expect(b?.remote_pane).toBe('%7');
	expect(a?.title).toBe('sibling A');
	expect(b?.title).toBe('sibling B');
	// The far-side agent classification survives the round trip too.
	expect(a?.agent).toBe('claude');
	expect(b?.agent).toBe('codex');
});

// The reap sweep judges each sibling by its own (shared) local pane and
// removes by session_id: when the pane dies, ALL siblings go; while it
// lives, none do — and reaping an unrelated dead-pane ticket in the same
// sweep never touches them (D8).
test('reconcile reaps siblings together with their pane and never one at a time', async () => {
	useTempSessionsFile();
	cleanups.push(() => {
		remove('sib-live-a');
		remove('sib-live-b');
		remove('other-dead');
	});

	const seed = (session_id: string, tmux_pane: string, remote_pane?: string) =>
		upsert({
			session_id,
			tmux_pane,
			cwd: '/remote/proj',
			title: session_id,
			event_type: 'Stop',
			created_at: Date.now() - 10_000,
			remote: true,
			...(remote_pane ? { remote_pane } : {})
		});
	seed('sib-live-a', '%86', '%3');
	seed('sib-live-b', '%86', '%7');
	seed('other-dead', '%87', '%2');

	await runBootScan({
		listPanes: async () => [sshPane('%86', 8600)],
		readSessionMetas: async () => [],
		parentPid: async () => null
	});

	expect(list().find((x) => x.session_id === 'sib-live-a')).toBeDefined();
	expect(list().find((x) => x.session_id === 'sib-live-b')).toBeDefined();
	expect(list().find((x) => x.session_id === 'other-dead')).toBeUndefined();

	// Second pass with the pane gone: both siblings reap together.
	await runBootScan({
		listPanes: async () => [],
		readSessionMetas: async () => [],
		parentPid: async () => null
	});
	expect(list().find((x) => x.session_id === 'sib-live-a')).toBeUndefined();
	expect(list().find((x) => x.session_id === 'sib-live-b')).toBeUndefined();
});

// Detached-state sweep for remote panes (settled 2026-07-12): the full
// reconcile flips an existing remote ticket's attach flag from the pane row
// without re-seeding it.
test('reconcile flips a remote ticket detached when its ssh pane detaches', async () => {
	useTempSessionsFile();
	cleanups.push(() => remove('remote-flip'));

	upsert({
		session_id: 'remote-flip',
		tmux_pane: '%83',
		cwd: '/remote/proj',
		title: 'flip box',
		event_type: 'PermissionRequest',
		created_at: Date.now(),
		remote: true
	});

	await runBootScan({
		listPanes: async () => [sshPane('%83', 8300, false)],
		readSessionMetas: async () => [],
		parentPid: async () => null
	});

	const t = list().find((x) => x.session_id === 'remote-flip');
	expect(t?.attached).toBe(false);
	expect(t?.event_type).toBe('PermissionRequest'); // untouched by the sweep
});

// The instant (tmux-hook light) path covers ssh panes too — the attach map is
// built from ALL panes, not just claude panes.
test('light reconcile flips a remote ticket without a full scan', async () => {
	useTempSessionsFile();
	cleanups.push(() => remove('remote-light'));

	upsert({
		session_id: 'remote-light',
		tmux_pane: '%84',
		cwd: '/remote/proj',
		title: 'light box',
		event_type: 'Stop',
		created_at: Date.now(),
		remote: true
	});

	await reconcile(
		{
			listPanes: async () => [sshPane('%84', 8400, false)],
			readSessionMetas: async () => [],
			parentPid: async () => null
		},
		'light'
	);

	expect(list().find((t) => t.session_id === 'remote-light')?.attached).toBe(false);
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
