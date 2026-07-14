import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

import { listPanes, parentPid, type PaneRow } from './bootScan';
import { loadSessions, type SessionsMap } from './sessionsStore';

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

// The five side-effecting inputs of the resolution walk, injectable so tests
// can feed synthetic lsof/ps/tmux/sessions combinations — the same pattern as
// bootScan's BootScanDeps.
export type CorrelationDeps = {
	loadSessions: () => Promise<SessionsMap>;
	listPanes: () => Promise<PaneRow[]>;
	lsofEstablishedPids: (port: number) => Promise<number[]>;
	processCommand: (pid: number) => Promise<string | null>;
	parentPid: (pid: number) => Promise<number | null>;
};

// `lsof -t` prints one pid per line; a pid holding several fds on the same
// connection prints repeatedly, so dedupe. lsof exits non-zero when nothing
// matches — the caller treats a throw as "no candidates".
async function lsofEstablishedPids(port: number): Promise<number[]> {
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
async function processCommand(pid: number): Promise<string | null> {
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
	parentPid
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

	const cached = (await deps.loadSessions())[sessionId];
	if (cached && panes.some((p) => p.pane_id === cached.tmux_pane)) {
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
			if (paneId !== undefined) return { ok: true, paneId };
			pid = await deps.parentPid(pid);
		}
	}
	return {
		ok: false,
		step: 'pane-walk',
		detail: `ssh pid(s) [${sshPids.join(', ')}] do not descend from any tmux pane`
	};
}
