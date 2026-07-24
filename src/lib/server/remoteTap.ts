import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

import { loadSessions, type SessionsMap } from './sessionsStore';
import {
	parseSshConnection,
	lsofEstablishedPids,
	processCommand,
	parseSshDestination
} from './sshCorrelation';

const execFileAsync = promisify(execFile);

// Tap transport for remote-tmux tickets (D16): the daemon never sshs into a
// devbox (the user has password+2FA and no keys), so the devbox runs a small
// helper that long-polls this module through the reverse tunnel. A tap
// answers the helper's open poll with the far-side pane id; the helper flips
// the window locally on the box and POSTs the outcome back, and only after
// that confirmation does the focus route touch anything local — no
// half-actions (decision 10).
//
// Box identity (fills a D16 gap): several installed devboxes may each have a
// helper polling, and on the Mac every tunnel terminates at the same
// loopback port, so polls are indistinguishable by origin. Answering the
// wrong box's poll would silently flip a window on the wrong machine (%N
// pane ids collide across servers). The helper therefore self-reports its
// box's ssh host PUBLIC keys, and a tap resolves its ticket's box the same
// way D18's tunnel matcher does — by stored host key: the ticket's persisted
// ssh_connection → lsof → the local ssh client's argv → the destination the
// user typed → known_hosts blob(s). The tap is delivered only to a poll
// whose reported keys intersect the ticket's. No match, no poll → loud
// RemoteTapError, never a guess.

export class RemoteTapError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'RemoteTapError';
	}
}

export type Tap = { tap_id: string; remote_pane: string };
export type PollAnswer = { tap: Tap | null };
export type TapResult = {
	ok: boolean;
	// Far session state read by the helper right after the flip. attached
	// false triggers the OQ4(a) local `tmux attach` injection; session_name
	// is what gets attached.
	session_attached?: boolean;
	session_name?: string;
	error?: string;
};

// How long a helper's poll is held open before answering "no tap" (the
// helper immediately re-polls). Short enough that a dead helper's socket
// state is discovered quickly, long enough to keep the tunnel quiet.
const POLL_HOLD_MS = 25_000;
// A tap that finds no poll waiting gives an arriving poll this long to show
// up before failing. This covers the helper's re-poll gap (the milliseconds
// between an answered poll and the next one), NOT a missing helper — that
// still fails loudly, just 1.5s later than instantly.
const DISPATCH_GRACE_MS = 1_500;
// The helper's flip is a local tmux exec plus one tunnel round trip;
// anything slower than this means the helper died mid-tap.
const RESULT_TIMEOUT_MS = 3_000;

type WaitingPoll = {
	hostKeys: Set<string>;
	answer: (a: PollAnswer) => void;
	timer: ReturnType<typeof setTimeout>;
};

type PendingDispatch = {
	blobs: string[];
	claim: (poll: WaitingPoll) => void;
};

const waitingPolls = new Set<WaitingPoll>();
const pendingDispatches = new Set<PendingDispatch>();
const pendingResults = new Map<
	string,
	{ resolve: (r: TapResult) => void; timer: ReturnType<typeof setTimeout> }
>();

function intersects(blobs: string[], hostKeys: Set<string>): boolean {
	return blobs.some((b) => hostKeys.has(b));
}

// Parks a helper's poll until a tap for its box arrives or the hold expires.
// If a tap is already waiting for this box (arrived during the helper's
// re-poll gap), the poll is consumed immediately.
export function registerPoll(
	hostKeys: string[],
	opts: { holdMs?: number } = {}
): Promise<PollAnswer> {
	const keys = new Set(hostKeys);
	return new Promise<PollAnswer>((resolve) => {
		const poll: WaitingPoll = {
			hostKeys: keys,
			answer: resolve,
			// Placeholder; replaced below. Needed so the object is complete
			// before any dispatch can claim it.
			timer: setTimeout(() => {}, 0)
		};
		clearTimeout(poll.timer);
		for (const d of pendingDispatches) {
			if (intersects(d.blobs, keys)) {
				pendingDispatches.delete(d);
				d.claim(poll);
				return;
			}
		}
		poll.timer = setTimeout(() => {
			waitingPolls.delete(poll);
			resolve({ tap: null });
		}, opts.holdMs ?? POLL_HOLD_MS);
		waitingPolls.add(poll);
	});
}

// Resolves a helper's posted tap outcome to the dispatch awaiting it. A
// result for an unknown tap_id (late, after the dispatch timed out) is
// reported false and otherwise ignored.
export function postResult(tap_id: string, result: TapResult): boolean {
	const pending = pendingResults.get(tap_id);
	if (!pending) return false;
	pendingResults.delete(tap_id);
	clearTimeout(pending.timer);
	pending.resolve(result);
	return true;
}

// Delivers a tap to the (single) helper whose box matches `blobs` and
// resolves with the helper's confirmed outcome. Throws RemoteTapError when
// no helper for the box is polling (after the short arrival grace) or when
// the helper fails to confirm in time — the caller turns both into a 410
// with nothing moved.
export function dispatchTap(
	blobs: string[],
	remote_pane: string,
	opts: { graceMs?: number; resultTimeoutMs?: number } = {}
): Promise<TapResult> {
	if (blobs.length === 0) {
		return Promise.reject(
			new RemoteTapError('ticket resolved to no host keys — cannot pick a devbox helper')
		);
	}
	return new Promise<TapResult>((resolve, reject) => {
		const deliver = (poll: WaitingPoll): void => {
			const tap_id = randomBytes(16).toString('hex');
			const timer = setTimeout(() => {
				pendingResults.delete(tap_id);
				reject(new RemoteTapError('devbox helper did not confirm the window flip'));
			}, opts.resultTimeoutMs ?? RESULT_TIMEOUT_MS);
			pendingResults.set(tap_id, { resolve, timer });
			poll.answer({ tap: { tap_id, remote_pane } });
		};

		for (const poll of waitingPolls) {
			if (intersects(blobs, poll.hostKeys)) {
				waitingPolls.delete(poll);
				clearTimeout(poll.timer);
				deliver(poll);
				return;
			}
		}

		const dispatch: PendingDispatch = { blobs, claim: deliver };
		pendingDispatches.add(dispatch);
		setTimeout(() => {
			if (!pendingDispatches.delete(dispatch)) return; // already claimed
			reject(
				new RemoteTapError(
					'no devbox helper connected for this box — is the ssh connection open?'
				)
			);
		}, opts.graceMs ?? DISPATCH_GRACE_MS);
	});
}

// ─── Box identity of a ticket ────────────────────────────────────────────────

// ps -o args= for one pid; null when the pid is gone.
async function processArgs(pid: number): Promise<string | null> {
	try {
		const { stdout } = await execFileAsync('ps', ['-o', 'args=', '-p', String(pid)]);
		const args = stdout.trim();
		return args || null;
	} catch {
		return null;
	}
}

// `ssh-keygen -F <name>` prints the known_hosts entries recorded under that
// name (hashed entries included — -F hashes the query). Returned as
// "keytype base64" blob strings, the same shape the helper reports from its
// /etc/ssh/ssh_host_*.pub files, so identity is a set intersection. Empty on
// no match or error.
async function knownHostsLookup(name: string): Promise<string[]> {
	try {
		const { stdout } = await execFileAsync('ssh-keygen', ['-F', name]);
		const blobs: string[] = [];
		for (const line of stdout.split('\n')) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith('#')) continue;
			// Entry lines are "<host-or-hash> <keytype> <base64> [comment]".
			// Every real key type contains a dash (ssh-ed25519, ecdsa-sha2-…);
			// anything else in that field is not an entry line.
			const parts = trimmed.split(/\s+/);
			if (parts.length < 3 || !parts[1].includes('-')) continue;
			blobs.push(`${parts[1]} ${parts[2]}`);
		}
		return blobs;
	} catch {
		return [];
	}
}

// Injectable side effects, mirroring CorrelationDeps: tests feed synthetic
// process tables and known_hosts answers.
export type RemoteTapDeps = {
	loadSessions: () => Promise<SessionsMap>;
	lsofEstablishedPids: (port: number) => Promise<number[]>;
	processCommand: (pid: number) => Promise<string | null>;
	processArgs: (pid: number) => Promise<string | null>;
	knownHostsLookup: (name: string) => Promise<string[]>;
};

const defaultDeps: RemoteTapDeps = {
	loadSessions,
	lsofEstablishedPids,
	processCommand,
	processArgs,
	knownHostsLookup
};

let activeDeps: RemoteTapDeps = defaultDeps;
export function setRemoteTapDepsForTest(deps: RemoteTapDeps | null): void {
	activeDeps = deps ?? defaultDeps;
}

// Resolves the host-key blobs of the box a remote-tmux ticket lives on, via
// the connection the ticket's events correlated: persisted ssh_connection →
// the local ssh client that owns its port → the destination spelling in that
// client's argv → the Mac's known_hosts entry for that spelling. Every step
// exists by construction while the connection is open (the connection IS an
// ssh client the user launched, and connecting recorded the key), so any
// failure is loud and named. This also enforces D16's gate — a dead
// connection fails at the lsof step, so taps are only served while the
// user's ssh connection is visibly open on the Mac.
export async function resolveTicketHostKeys(
	sessionId: string,
	deps: RemoteTapDeps = activeDeps
): Promise<string[]> {
	const entry = (await deps.loadSessions())[sessionId];
	if (!entry) throw new RemoteTapError(`no persisted session entry for ${sessionId.slice(0, 8)}`);
	if (!entry.ssh_connection) {
		throw new RemoteTapError('session entry has no recorded ssh connection');
	}
	const conn = parseSshConnection(entry.ssh_connection);
	if (!conn) throw new RemoteTapError('recorded ssh connection is malformed');

	let pids: number[] = [];
	try {
		pids = await deps.lsofEstablishedPids(conn.clientPort);
	} catch {
		pids = [];
	}
	if (pids.length === 0) {
		throw new RemoteTapError(
			`the ticket's ssh connection (local port ${conn.clientPort}) is no longer open`
		);
	}

	for (const pid of pids) {
		const comm = await deps.processCommand(pid);
		// Same filter as the correlation walk: exactly `ssh`, so wrappers like
		// autossh or unrelated port sharers never contribute an argv.
		if (!comm || path.basename(comm) !== 'ssh') continue;
		const args = await deps.processArgs(pid);
		if (!args) continue;
		const dest = parseSshDestination(args);
		if (!dest) continue;
		// Non-22 ports are recorded in known_hosts as [host]:port; try the
		// port-qualified form first when the client was launched with -p.
		const names = dest.port ? [`[${dest.host}]:${dest.port}`, dest.host] : [dest.host];
		for (const name of names) {
			const blobs = await deps.knownHostsLookup(name);
			if (blobs.length > 0) return blobs;
		}
		throw new RemoteTapError(
			`no known_hosts entry for '${dest.host}' — the box's key was never recorded?`
		);
	}
	throw new RemoteTapError(
		`no ssh client argv resolved a destination on local port ${conn.clientPort}`
	);
}
