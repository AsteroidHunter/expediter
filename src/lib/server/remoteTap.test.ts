import { test, expect } from 'bun:test';
import {
	registerPoll,
	dispatchTap,
	postResult,
	resolveTicketHostKeys,
	RemoteTapError,
	type RemoteTapDeps
} from './remoteTap';

// ─── poll ↔ dispatch matching ───────────────────────────────────────────────

const KEYS = ['ssh-ed25519 AAAAbench'];

// The bundled bun:test Matchers type has no `.rejects`, so rejection is
// asserted through a plain try/catch (same workaround family as the
// expectStep helper in sshCorrelation.test.ts).
async function expectTapError(p: Promise<unknown>, containing: string): Promise<void> {
	let err: unknown = null;
	try {
		await p;
	} catch (e) {
		err = e;
	}
	expect(err instanceof RemoteTapError).toBe(true);
	expect((err as Error).message).toContain(containing);
}


test('a waiting poll with matching keys receives the tap and its result resolves the dispatch', async () => {
	const pollPromise = registerPoll(KEYS, { holdMs: 5000 });
	const dispatchPromise = dispatchTap(KEYS, '%3', { graceMs: 500, resultTimeoutMs: 2000 });

	const answer = await pollPromise;
	expect(answer.tap).not.toBeNull();
	expect(answer.tap?.remote_pane).toBe('%3');

	const matched = postResult(answer.tap!.tap_id, {
		ok: true,
		session_attached: true,
		session_name: 'main'
	});
	expect(matched).toBe(true);

	const result = await dispatchPromise;
	expect(result.ok).toBe(true);
	expect(result.session_attached).toBe(true);
	expect(result.session_name).toBe('main');
});

test('a poll with non-matching keys is never claimed; the dispatch fails after the grace', async () => {
	const pollPromise = registerPoll(['ssh-ed25519 AAAAotherbox'], { holdMs: 300 });
	await expectTapError(dispatchTap(KEYS, '%3', { graceMs: 120, resultTimeoutMs: 500 }), '');
	// The unmatched poll expires on its own with an empty answer.
	expect((await pollPromise).tap).toBeNull();
});

test('a dispatch with no poll waiting is claimed by a poll arriving within the grace', async () => {
	const dispatchPromise = dispatchTap(KEYS, '%7', { graceMs: 800, resultTimeoutMs: 2000 });
	await new Promise((r) => setTimeout(r, 100));
	const answer = await registerPoll(KEYS, { holdMs: 5000 });
	expect(answer.tap?.remote_pane).toBe('%7');
	postResult(answer.tap!.tap_id, { ok: true });
	expect((await dispatchPromise).ok).toBe(true);
});

test('a dispatch whose helper never confirms times out with a RemoteTapError', async () => {
	const pollPromise = registerPoll(KEYS, { holdMs: 5000 });
	await expectTapError(dispatchTap(KEYS, '%3', { graceMs: 500, resultTimeoutMs: 150 }), 'did not confirm');
	// The tap was delivered; only the confirmation is missing.
	expect((await pollPromise).tap).not.toBeNull();
});

test('a late result for a timed-out tap reports unmatched', async () => {
	const pollPromise = registerPoll(KEYS, { holdMs: 5000 });
	await dispatchTap(KEYS, '%3', { graceMs: 500, resultTimeoutMs: 100 }).catch(() => {});
	const answer = await pollPromise;
	expect(postResult(answer.tap!.tap_id, { ok: true })).toBe(false);
});

test('an expired poll answers empty and a later dispatch fails rather than guessing', async () => {
	expect((await registerPoll(KEYS, { holdMs: 50 })).tap).toBeNull();
	await expectTapError(dispatchTap(KEYS, '%3', { graceMs: 100, resultTimeoutMs: 500 }), 'no devbox helper');
});

test('dispatchTap with no host keys refuses immediately', async () => {
	await expectTapError(dispatchTap([], '%3', { graceMs: 100 }), 'no host keys');
});

// ─── resolveTicketHostKeys (box identity via the ticket's connection) ───────

const ENTRY_CONN = '10.0.0.5 52814 10.0.0.9 22';

function makeDeps(overrides: Partial<RemoteTapDeps> = {}): RemoteTapDeps {
	return {
		loadSessions: async () => ({
			sid: {
				session_id: 'sid',
				tmux_pane: '%9',
				cwd: '/r',
				transcript_path: '/r/t.jsonl',
				remote: true,
				remote_pane: '%3',
				ssh_connection: ENTRY_CONN
			}
		}),
		lsofEstablishedPids: async () => [4021],
		processCommand: async () => '/usr/bin/ssh',
		processArgs: async () => 'ssh devbox',
		knownHostsLookup: async (name) =>
			name === 'devbox' ? ['ssh-ed25519 AAAAdevboxblob'] : [],
		...overrides
	};
}

test('resolveTicketHostKeys walks connection → ssh argv → known_hosts blobs', async () => {
	expect(await resolveTicketHostKeys('sid', makeDeps())).toEqual(['ssh-ed25519 AAAAdevboxblob']);
});

test('resolveTicketHostKeys tries the [host]:port form first for explicit ports', async () => {
	const lookups: string[] = [];
	const deps = makeDeps({
		processArgs: async () => 'ssh -p 2222 devbox',
		knownHostsLookup: async (name) => {
			lookups.push(name);
			return name === '[devbox]:2222' ? ['ssh-ed25519 AAAAportblob'] : [];
		}
	});
	expect(await resolveTicketHostKeys('sid', deps)).toEqual(['ssh-ed25519 AAAAportblob']);
	expect(lookups[0]).toBe('[devbox]:2222');
});

test('resolveTicketHostKeys fails loudly when the connection is no longer open', async () => {
	const deps = makeDeps({ lsofEstablishedPids: async () => [] });
	await expectTapError(resolveTicketHostKeys('sid', deps), 'no longer open');
});

test('resolveTicketHostKeys fails loudly on a session without a recorded connection', async () => {
	const deps = makeDeps({
		loadSessions: async () => ({
			sid: {
				session_id: 'sid',
				tmux_pane: '%9',
				cwd: '/r',
				transcript_path: '/r/t.jsonl',
				remote: true
			}
		})
	});
	await expectTapError(resolveTicketHostKeys('sid', deps), 'no recorded ssh connection');
});

test('resolveTicketHostKeys fails loudly when known_hosts has no entry for the destination', async () => {
	const deps = makeDeps({ knownHostsLookup: async () => [] });
	await expectTapError(resolveTicketHostKeys('sid', deps), 'no known_hosts entry');
});

test('resolveTicketHostKeys ignores non-ssh port sharers and unknown sessions fail', async () => {
	const deps = makeDeps({
		lsofEstablishedPids: async () => [4020, 4021],
		processCommand: async (pid) => (pid === 4020 ? 'nc' : 'ssh')
	});
	expect(await resolveTicketHostKeys('sid', deps)).toEqual(['ssh-ed25519 AAAAdevboxblob']);
	await expectTapError(resolveTicketHostKeys('nope', makeDeps()), 'no persisted session');
});
