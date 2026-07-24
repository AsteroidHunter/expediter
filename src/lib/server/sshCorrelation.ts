import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

import { listPanes, parentPid, type PaneRow } from './bootScan';
import { loadSessions, updateSessionConnection, type SessionsMap } from './sessionsStore';

const execFileAsync = promisify(execFile);

// Correlation for remote sessions: a claude running on another box over ssh
// can't know which local tmux pane holds its ssh client, but sshd hands it
// $SSH_CONNECTION ("clientIP clientPort serverIP serverPort") for free. On a
// direct TCP path the client port equals the local ssh process's source port
// (assumption A1), so the pane is recoverable entirely on this machine:
// client port → lsof → local ssh pid → ppid walk → tmux pane. All failure
// modes are named and surface as a 422 in the handler — a ticket that cannot
// focus must never exist (decision 10).

export type SshConnectionInfo = {
	clientIp: string;
	clientPort: number;
	serverIp: string;
	serverPort: number;
};

// Strict decimal — Number() alone would accept hex ("0x14") and exponent
// forms, which sshd never emits.
const PORT_PATTERN = /^\d{1,5}$/;

function parsePort(raw: string): number | null {
	if (!PORT_PATTERN.test(raw)) return null;
	const port = Number(raw);
	return port >= 1 && port <= 65535 ? port : null;
}

// Parses a verbatim $SSH_CONNECTION value. IPv6 addresses contain colons but
// no whitespace, so the 4-field whitespace split holds for both families.
export function parseSshConnection(raw: string): SshConnectionInfo | null {
	if (typeof raw !== 'string') return null;
	const parts = raw.trim().split(/\s+/);
	if (parts.length !== 4) return null;
	const [clientIp, clientPortRaw, serverIp, serverPortRaw] = parts;
	const clientPort = parsePort(clientPortRaw);
	const serverPort = parsePort(serverPortRaw);
	if (clientPort === null || serverPort === null) return null;
	return { clientIp, clientPort, serverIp, serverPort };
}

// ssh flags that consume the following argv token. Derived from ssh(1)'s
// option string; anything here appearing bare means "skip the next token"
// when hunting for the destination in a client's argv.
const SSH_OPTION_TAKING_FLAGS = new Set([
	'-B',
	'-b',
	'-c',
	'-D',
	'-E',
	'-e',
	'-F',
	'-I',
	'-i',
	'-J',
	'-L',
	'-l',
	'-m',
	'-O',
	'-o',
	'-p',
	'-Q',
	'-R',
	'-S',
	'-W',
	'-w'
]);

// Extracts the destination a live ssh client was launched at from its
// `ps -o args=` line: first non-flag token after the binary, with
// option-taking flags (and their values, separate or embedded like -p2222)
// skipped, a user@ prefix stripped, and ssh:// URIs unwrapped. The port is
// reported when it was explicit (-p or URI) so known_hosts lookups can try
// the [host]:port form first. Null when no destination token exists. Pure
// for unit-testing; used by remoteTap to identify a ticket's box by host
// key, not to build any command line.
export function parseSshDestination(argsLine: string): { host: string; port?: number } | null {
	const tokens = argsLine.trim().split(/\s+/);
	let port: number | undefined;
	for (let i = 1; i < tokens.length; i++) {
		const tok = tokens[i];
		if (tok.startsWith('-') && tok.length > 1) {
			const flag = tok.slice(0, 2);
			if (SSH_OPTION_TAKING_FLAGS.has(flag)) {
				const value = tok.length > 2 ? tok.slice(2) : tokens[++i];
				if (flag === '-p' && value && PORT_PATTERN.test(value)) port = Number(value);
			}
			// Boolean flags (and clusters like -4A) carry no value: just skip.
			continue;
		}
		// First non-flag token is the destination; everything after would be
		// the remote command, which we never read.
		let dest = tok;
		if (dest.startsWith('ssh://')) {
			dest = dest.slice('ssh://'.length);
			const slash = dest.indexOf('/');
			if (slash >= 0) dest = dest.slice(0, slash);
			const at = dest.lastIndexOf('@');
			if (at >= 0) dest = dest.slice(at + 1);
			const colon = dest.lastIndexOf(':');
			if (colon >= 0 && PORT_PATTERN.test(dest.slice(colon + 1))) {
				port = Number(dest.slice(colon + 1));
				dest = dest.slice(0, colon);
			}
			return dest ? { host: dest, ...(port ? { port } : {}) } : null;
		}
		const at = dest.lastIndexOf('@');
		if (at >= 0) dest = dest.slice(at + 1);
		return dest ? { host: dest, ...(port ? { port } : {}) } : null;
	}
	return null;
}

// The side-effecting inputs of the resolution walk, injectable so tests can
// feed synthetic lsof/ps/tmux/sessions combinations — the same pattern as
// bootScan's BootScanDeps. updateSessionConnection is the walk's one output
// seam: it persists what a successful full walk found (D11).
export type CorrelationDeps = {
	loadSessions: () => Promise<SessionsMap>;
	listPanes: () => Promise<PaneRow[]>;
	lsofEstablishedPids: (port: number) => Promise<number[]>;
	processCommand: (pid: number) => Promise<string | null>;
	parentPid: (pid: number) => Promise<number | null>;
	updateSessionConnection: (
		sessionId: string,
		paneId: string,
		sshConnection: string
	) => Promise<void>;
};

// `lsof -t` prints one pid per line; a pid holding several fds on the same
// connection prints repeatedly, so dedupe. lsof exits non-zero when nothing
// matches — the caller treats a throw as "no candidates". Exported for
// remoteTap's box-identity resolution, which walks the same ground.
export async function lsofEstablishedPids(port: number): Promise<number[]> {
	const { stdout } = await execFileAsync('lsof', [
		'-nP',
		`-iTCP:${port}`,
		'-sTCP:ESTABLISHED',
		'-t'
	]);
	const pids = new Set<number>();
	for (const line of stdout.split('\n')) {
		const pid = Number(line.trim());
		if (Number.isInteger(pid) && pid > 0) pids.add(pid);
	}
	return [...pids];
}

// `ps -o comm=` gives the executable name on Linux and the full executable
// path on macOS; callers basename() before comparing. Null when the pid died.
// Exported for remoteTap alongside lsofEstablishedPids.
export async function processCommand(pid: number): Promise<string | null> {
	try {
		const { stdout } = await execFileAsync('ps', ['-o', 'comm=', '-p', String(pid)]);
		const comm = stdout.trim();
		return comm || null;
	} catch {
		return null;
	}
}

const defaultDeps: CorrelationDeps = {
	loadSessions,
	listPanes,
	lsofEstablishedPids,
	processCommand,
	parentPid,
	updateSessionConnection
};

// Test seam for callers that can't thread a deps argument (the hook-event
// POST handler has a fixed signature). Pass null to restore production deps.
let activeDeps: CorrelationDeps = defaultDeps;
export function setCorrelationDepsForTest(deps: CorrelationDeps | null): void {
	activeDeps = deps ?? defaultDeps;
}

export type PaneResolution =
	| { ok: true; paneId: string }
	| {
			ok: false;
			step: 'parse' | 'tmux' | 'lsof' | 'ssh-process' | 'pane-walk';
			detail: string;
	  };

// An ssh client is at most a couple of forks below its pane shell (usually
// exactly one). Ten hops is comfortably past any real nesting while still
// bounding a pathological ppid cycle.
const MAX_PPID_HOPS = 10;

// Resolves the local tmux pane that owns the ssh connection named by a
// verbatim $SSH_CONNECTION string. Fast path first: sessions.json already
// maps this session_id to a pane from a prior event, so anything after the
// first event skips lsof entirely (the cached pane is still validated
// against the live pane set — a dead pane falls through to a fresh walk).
export async function resolveRemotePane(
	sessionId: string,
	sshConnection: string,
	deps: CorrelationDeps = activeDeps
): Promise<PaneResolution> {
	const conn = parseSshConnection(sshConnection);
	if (!conn) {
		return {
			ok: false,
			step: 'parse',
			detail: `malformed ssh_connection ${JSON.stringify(sshConnection)}`
		};
	}

	let panes: PaneRow[];
	try {
		panes = await deps.listPanes();
	} catch (err) {
		return { ok: false, step: 'tmux', detail: `tmux list-panes failed: ${err}` };
	}

	// Fast-path validity is pane liveness AND connection equality (D11). A
	// remote-tmux session outlives its ssh connection by design: after a
	// re-ssh from a different local window the old pane usually survives as a
	// bare shell prompt, so the pane check alone would pin every event — and
	// every tap — to the stale pane forever. A stored connection that differs
	// from the incoming (fresh, session-env) value forces a full re-walk.
	// Entries without a stored connection predate this field and keep the
	// pane-liveness-only semantics they were written under.
	const cached = (await deps.loadSessions())[sessionId];
	if (
		cached &&
		panes.some((p) => p.pane_id === cached.tmux_pane) &&
		(!cached.ssh_connection || cached.ssh_connection === sshConnection)
	) {
		return { ok: true, paneId: cached.tmux_pane };
	}

	let candidatePids: number[];
	try {
		candidatePids = await deps.lsofEstablishedPids(conn.clientPort);
	} catch {
		candidatePids = [];
	}
	if (candidatePids.length === 0) {
		return {
			ok: false,
			step: 'lsof',
			detail: `no ESTABLISHED process on local port ${conn.clientPort} (NAT-rewritten port or connection already gone?)`
		};
	}

	// lsof matches either endpoint of a connection on the port, so filter to
	// actual ssh clients — anything else on the same number is a bystander.
	const sshPids: number[] = [];
	for (const pid of candidatePids) {
		const comm = await deps.processCommand(pid);
		if (comm && path.basename(comm) === 'ssh') sshPids.push(pid);
	}
	if (sshPids.length === 0) {
		return {
			ok: false,
			step: 'ssh-process',
			detail: `no ssh process among pids [${candidatePids.join(', ')}] on port ${conn.clientPort}`
		};
	}

	// Walk each ssh pid up its parent chain until a pid matches a pane's
	// shell pid. The pid itself is checked first: a pane whose command IS ssh
	// (no intermediate shell) has pane_pid == ssh pid.
	const paneByPid = new Map<number, string>();
	for (const p of panes) paneByPid.set(p.pane_pid, p.pane_id);

	for (const sshPid of sshPids) {
		let pid: number | null = sshPid;
		for (let hop = 0; hop < MAX_PPID_HOPS && pid !== null && pid > 1; hop++) {
			const paneId = paneByPid.get(pid);
			if (paneId !== undefined) {
				// Persist what the walk found so the next event takes the fast
				// path against the CURRENT pane and connection (D11). Bookkeeping
				// only: a failed write must not fail a correlation that succeeded.
				try {
					await deps.updateSessionConnection(sessionId, paneId, sshConnection);
				} catch (err) {
					console.warn('[remote] updateSessionConnection failed', err);
				}
				return { ok: true, paneId };
			}
			pid = await deps.parentPid(pid);
		}
	}
	return {
		ok: false,
		step: 'pane-walk',
		detail: `ssh pid(s) [${sshPids.join(', ')}] do not descend from any tmux pane`
	};
}
