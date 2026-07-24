import { test, expect } from 'bun:test';
import {
	parseSshConnection,
	parseSshDestination,
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
		updateSessionConnection: async () => {},
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

// ─── D11: connection-equality on the fast path ──────────────────────────────

const NEW_CONN = '10.0.0.5 60999 10.0.0.9 22';

function cachedEntry(pane: string, ssh_connection?: string) {
	return {
		sid: {
			session_id: 'sid',
			tmux_pane: pane,
			cwd: '/r',
			transcript_path: '/r/t.jsonl',
			remote: true as const,
			...(ssh_connection ? { ssh_connection } : {})
		}
	};
}

test('fast path: stored connection equal to the incoming one is a hit (no lsof)', async () => {
	let lsofCalls = 0;
	const deps = makeDeps({
		loadSessions: async () => cachedEntry('%7', CONN),
		listPanes: async () => [paneRow('%7', 7001, 'ssh')],
		lsofEstablishedPids: async () => {
			lsofCalls++;
			return [];
		}
	});
	expect(await resolveRemotePane('sid', CONN, deps)).toEqual({ ok: true, paneId: '%7' });
	expect(lsofCalls).toBe(0);
});

// A remote-tmux session outlives its connection: after a re-ssh from another
// window the OLD pane survives as a bare prompt (still live), so only the
// connection mismatch can force the re-walk that finds the NEW pane. The walk
// must also persist what it found via the updateSessionConnection seam.
test('fast path: stored connection differing from the incoming forces a re-walk that persists', async () => {
	const persisted: Array<{ sessionId: string; paneId: string; conn: string }> = [];
	const deps = makeDeps({
		loadSessions: async () => cachedEntry('%7', CONN), // old pane still ALIVE
		listPanes: async () => [paneRow('%7', 7001, 'ssh'), paneRow('%8', 7008, 'ssh')],
		lsofEstablishedPids: async (port) => (port === 60999 ? [4021] : []),
		processCommand: async () => 'ssh',
		parentPid: async (pid) => (pid === 4021 ? 7008 : null),
		updateSessionConnection: async (sessionId, paneId, conn) => {
			persisted.push({ sessionId, paneId, conn });
		}
	});
	expect(await resolveRemotePane('sid', NEW_CONN, deps)).toEqual({ ok: true, paneId: '%8' });
	expect(persisted).toEqual([{ sessionId: 'sid', paneId: '%8', conn: NEW_CONN }]);
});

test('fast path: an entry with no stored connection keeps pane-liveness-only semantics', async () => {
	let lsofCalls = 0;
	const deps = makeDeps({
		loadSessions: async () => cachedEntry('%7'), // pre-plan entry, no ssh_connection
		listPanes: async () => [paneRow('%7', 7001, 'ssh')],
		lsofEstablishedPids: async () => {
			lsofCalls++;
			return [];
		}
	});
	// Any incoming connection value fast-paths while the pane lives.
	expect(await resolveRemotePane('sid', NEW_CONN, deps)).toEqual({ ok: true, paneId: '%7' });
	expect(lsofCalls).toBe(0);
});

test('a failing updateSessionConnection does not fail a successful walk', async () => {
	const deps = makeDeps({
		listPanes: async () => [paneRow('%5', 7001)],
		lsofEstablishedPids: async () => [4021],
		processCommand: async () => 'ssh',
		parentPid: async (pid) => (pid === 4021 ? 7001 : null),
		updateSessionConnection: async () => {
			throw new Error('disk full');
		}
	});
	expect(await resolveRemotePane('sid', CONN, deps)).toEqual({ ok: true, paneId: '%5' });
});

// ─── parseSshDestination (box identity for remote taps) ─────────────────────

test('parseSshDestination finds the destination through flags, users, and URIs', () => {
	expect(parseSshDestination('ssh devbox')).toEqual({ host: 'devbox' });
	expect(parseSshDestination('/usr/bin/ssh devbox')).toEqual({ host: 'devbox' });
	expect(parseSshDestination('ssh -p 2222 user@10.0.0.9')).toEqual({
		host: '10.0.0.9',
		port: 2222
	});
	expect(parseSshDestination('ssh -p2222 devbox.example.com')).toEqual({
		host: 'devbox.example.com',
		port: 2222
	});
	expect(
		parseSshDestination('ssh -o StrictHostKeyChecking=yes -i /k/id -L 8080:localhost:80 devbox tail -f log')
	).toEqual({ host: 'devbox' });
	expect(parseSshDestination('ssh -4A devbox')).toEqual({ host: 'devbox' });
	expect(parseSshDestination('ssh ssh://user@devbox:2200')).toEqual({
		host: 'devbox',
		port: 2200
	});
});

test('parseSshDestination returns null when no destination token exists', () => {
	expect(parseSshDestination('ssh -v')).toBeNull();
	expect(parseSshDestination('ssh')).toBeNull();
	expect(parseSshDestination('')).toBeNull();
});
