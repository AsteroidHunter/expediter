import { test, expect } from 'bun:test';
import {
	parseSshConnection,
	resolveRemotePane,
	type CorrelationDeps,
	type PaneResolution
} from './sshCorrelation';
import type { PaneRow } from './bootScan';

// Narrowing assertion for the failure arm of the PaneResolution union —
// the bundled bun:test Matchers type has no toMatchObject.
function expectStep(result: PaneResolution, step: string): void {
	expect(result.ok).toBe(false);
	if (result.ok) throw new Error('expected a failed resolution');
	expect(result.step).toBe(step as typeof result.step);
}

// ─── parseSshConnection ──────────────────────────────────────────────────────

test('parseSshConnection parses a valid IPv4 value', () => {
	expect(parseSshConnection('10.0.0.5 52814 10.0.0.9 22')).toEqual({
		clientIp: '10.0.0.5',
		clientPort: 52814,
		serverIp: '10.0.0.9',
		serverPort: 22
	});
});

test('parseSshConnection parses IPv6 addresses (colons, no whitespace)', () => {
	expect(parseSshConnection('2001:db8::1 52814 2001:db8::2 22')).toEqual({
		clientIp: '2001:db8::1',
		clientPort: 52814,
		serverIp: '2001:db8::2',
		serverPort: 22
	});
});

test('parseSshConnection tolerates surrounding and repeated whitespace', () => {
	expect(parseSshConnection('  10.0.0.5   52814  10.0.0.9   22  ')?.clientPort).toBe(52814);
});

test('parseSshConnection rejects malformed values', () => {
	expect(parseSshConnection('')).toBeNull();
	expect(parseSshConnection('garbage')).toBeNull();
	expect(parseSshConnection('10.0.0.5 52814 10.0.0.9')).toBeNull(); // 3 fields
	expect(parseSshConnection('10.0.0.5 52814 10.0.0.9 22 extra')).toBeNull(); // 5 fields
});

test('parseSshConnection rejects out-of-range and non-decimal ports', () => {
	expect(parseSshConnection('10.0.0.5 0 10.0.0.9 22')).toBeNull();
	expect(parseSshConnection('10.0.0.5 65536 10.0.0.9 22')).toBeNull();
	expect(parseSshConnection('10.0.0.5 0x14 10.0.0.9 22')).toBeNull(); // hex would pass Number()
	expect(parseSshConnection('10.0.0.5 abc 10.0.0.9 22')).toBeNull();
	expect(parseSshConnection('10.0.0.5 52814 10.0.0.9 99999')).toBeNull(); // server port checked too
});

// ─── resolveRemotePane ───────────────────────────────────────────────────────

function paneRow(pane_id: string, pane_pid: number, cmd = 'zsh'): PaneRow {
	return {
		pane_id,
		pane_pid,
		pane_current_command: cmd,
		pane_current_path: '/',
		session_attached: true
	};
}

function makeDeps(overrides: Partial<CorrelationDeps> = {}): CorrelationDeps {
	return {
		loadSessions: async () => ({}),
		listPanes: async () => [],
		lsofEstablishedPids: async () => [],
		processCommand: async () => null,
		parentPid: async () => null,
		...overrides
	};
}

const CONN = '10.0.0.5 52814 10.0.0.9 22';

test('resolveRemotePane names the parse step on a malformed ssh_connection', async () => {
	expectStep(await resolveRemotePane('sid', 'not a connection', makeDeps()), 'parse');
});

test('resolveRemotePane names the tmux step when list-panes throws', async () => {
	const deps = makeDeps({
		listPanes: async () => {
			throw new Error('no tmux server');
		}
	});
	expectStep(await resolveRemotePane('sid', CONN, deps), 'tmux');
});

test('fast path: a cached sessions.json pane that is still live wins without lsof', async () => {
	let lsofCalls = 0;
	const deps = makeDeps({
		loadSessions: async () => ({
			sid: {
				session_id: 'sid',
				tmux_pane: '%7',
				cwd: '/r',
				transcript_path: '/r/t.jsonl',
				remote: true
			}
		}),
		listPanes: async () => [paneRow('%7', 7001, 'ssh')],
		lsofEstablishedPids: async () => {
			lsofCalls++;
			return [];
		}
	});
	const result = await resolveRemotePane('sid', CONN, deps);
	expect(result).toEqual({ ok: true, paneId: '%7' });
	expect(lsofCalls).toBe(0);
});

test('fast path: a cached pane that is no longer live falls through to the walk', async () => {
	const deps = makeDeps({
		loadSessions: async () => ({
			sid: {
				session_id: 'sid',
				tmux_pane: '%dead',
				cwd: '/r',
				transcript_path: '/r/t.jsonl',
				remote: true
			}
		}),
		listPanes: async () => [paneRow('%3', 7001)],
		lsofEstablishedPids: async () => [4021],
		processCommand: async () => '/usr/bin/ssh',
		parentPid: async (pid) => (pid === 4021 ? 7001 : null)
	});
	const result = await resolveRemotePane('sid', CONN, deps);
	expect(result).toEqual({ ok: true, paneId: '%3' });
});

test('resolveRemotePane names the lsof step when no process holds the port', async () => {
	const deps = makeDeps({ listPanes: async () => [paneRow('%1', 100)] });
	expectStep(await resolveRemotePane('sid', CONN, deps), 'lsof');
});

test('resolveRemotePane names the lsof step when the lsof call itself throws', async () => {
	const deps = makeDeps({
		listPanes: async () => [paneRow('%1', 100)],
		lsofEstablishedPids: async () => {
			throw new Error('lsof exit 1'); // lsof exits non-zero on no matches
		}
	});
	expectStep(await resolveRemotePane('sid', CONN, deps), 'lsof');
});

test('resolveRemotePane names the ssh-process step when no candidate pid is ssh', async () => {
	const deps = makeDeps({
		listPanes: async () => [paneRow('%1', 100)],
		lsofEstablishedPids: async () => [4021, 4022],
		processCommand: async () => 'python3'
	});
	expectStep(await resolveRemotePane('sid', CONN, deps), 'ssh-process');
});

test('sshd is not mistaken for an ssh client (basename must equal ssh exactly)', async () => {
	const deps = makeDeps({
		listPanes: async () => [paneRow('%1', 100)],
		lsofEstablishedPids: async () => [4021],
		processCommand: async () => '/usr/sbin/sshd'
	});
	expectStep(await resolveRemotePane('sid', CONN, deps), 'ssh-process');
});

test('the full walk resolves: lsof pid → ssh comm → ppid hop → pane shell pid', async () => {
	const deps = makeDeps({
		listPanes: async () => [paneRow('%42', 7001), paneRow('%43', 7002)],
		lsofEstablishedPids: async () => [4021],
		// macOS ps -o comm= returns the full executable path.
		processCommand: async () => '/usr/bin/ssh',
		parentPid: async (pid) => (pid === 4021 ? 7001 : null)
	});
	const result = await resolveRemotePane('sid', CONN, deps);
	expect(result).toEqual({ ok: true, paneId: '%42' });
});

test('a bare `ssh` comm (Linux style) passes the filter too', async () => {
	const deps = makeDeps({
		listPanes: async () => [paneRow('%42', 7001)],
		lsofEstablishedPids: async () => [4021],
		processCommand: async () => 'ssh',
		parentPid: async (pid) => (pid === 4021 ? 7001 : null)
	});
	expect(await resolveRemotePane('sid', CONN, deps)).toEqual({ ok: true, paneId: '%42' });
});

test('a pane whose command IS ssh resolves with zero hops (pane_pid == ssh pid)', async () => {
	const deps = makeDeps({
		listPanes: async () => [paneRow('%9', 4021, 'ssh')],
		lsofEstablishedPids: async () => [4021],
		processCommand: async () => 'ssh',
		parentPid: async () => null // must never be needed
	});
	expect(await resolveRemotePane('sid', CONN, deps)).toEqual({ ok: true, paneId: '%9' });
});

test('a multi-hop parent chain (ssh under a subshell under the pane shell) resolves', async () => {
	const deps = makeDeps({
		listPanes: async () => [paneRow('%5', 7001)],
		lsofEstablishedPids: async () => [4021],
		processCommand: async () => 'ssh',
		parentPid: async (pid) => (pid === 4021 ? 5000 : pid === 5000 ? 7001 : null)
	});
	expect(await resolveRemotePane('sid', CONN, deps)).toEqual({ ok: true, paneId: '%5' });
});

test('resolveRemotePane names the pane-walk step when the chain dead-ends', async () => {
	const deps = makeDeps({
		listPanes: async () => [paneRow('%5', 7001)],
		lsofEstablishedPids: async () => [4021],
		processCommand: async () => 'ssh',
		parentPid: async () => null // orphaned ssh, no pane ancestry
	});
	expectStep(await resolveRemotePane('sid', CONN, deps), 'pane-walk');
});

test('among several candidate pids, the ssh one that descends from a pane wins', async () => {
	const deps = makeDeps({
		listPanes: async () => [paneRow('%8', 7008)],
		lsofEstablishedPids: async () => [4020, 4021],
		processCommand: async (pid) => (pid === 4020 ? 'nc' : 'ssh'),
		parentPid: async (pid) => (pid === 4021 ? 7008 : null)
	});
	expect(await resolveRemotePane('sid', CONN, deps)).toEqual({ ok: true, paneId: '%8' });
});
