import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { watchForDecline } from './declineWatcher';

// Tests live under ~/.claude/ so they satisfy the watcher's containment check
// without exposing a test backdoor in production code. The temp dirs are
// per-test and cleaned up in afterEach.
let tempDir: string;
let tempFile: string;

beforeEach(() => {
	tempDir = mkdtempSync(path.join(os.homedir(), '.claude', '.expediter-test-'));
	tempFile = path.join(tempDir, 'transcript.jsonl');
	writeFileSync(tempFile, '');
});

afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (predicate()) return true;
		await sleep(10);
	}
	return predicate();
}

const denialLine =
	JSON.stringify({
		type: 'user',
		message: {
			content: [
				{
					type: 'tool_result',
					is_error: true,
					content:
						"The user doesn't want to proceed with this tool use. The tool use was rejected.",
					tool_use_id: 'toolu_abc'
				}
			]
		}
	}) + '\n';

const successLine =
	JSON.stringify({
		type: 'user',
		message: {
			content: [
				{
					type: 'tool_result',
					is_error: false,
					content: 'totally fine output',
					tool_use_id: 'toolu_xyz'
				}
			]
		}
	}) + '\n';

test('fires onDecline when a denial line is appended after the watch starts', async () => {
	let fired = false;
	const cancel = watchForDecline({
		transcriptPath: tempFile,
		sessionId: 'test-session-decline',
		createdAt: 0,
		onDecline: () => {
			fired = true;
		}
	});

	await sleep(80); // let initial stat + watch.attach settle
	appendFileSync(tempFile, denialLine);

	expect(await waitFor(() => fired)).toBe(true);
	cancel();
});

test('does not fire onDecline for unrelated tool_result lines', async () => {
	let fired = false;
	const cancel = watchForDecline({
		transcriptPath: tempFile,
		sessionId: 'test-session-success',
		createdAt: 0,
		onDecline: () => {
			fired = true;
		}
	});

	await sleep(80);
	appendFileSync(tempFile, successLine);
	await sleep(300); // well past 50ms debounce + processing

	expect(fired).toBe(false);
	cancel();
});

test('safety timeout cancels the watcher; later denials do not fire', async () => {
	let fired = false;
	const cancel = watchForDecline({
		transcriptPath: tempFile,
		sessionId: 'test-session-timeout',
		createdAt: 0,
		timeoutMs: 80,
		onDecline: () => {
			fired = true;
		}
	});

	await sleep(200); // past timeout
	appendFileSync(tempFile, denialLine);
	await sleep(200);

	expect(fired).toBe(false);
	cancel();
});

test('cancel handle is idempotent', async () => {
	const cancel = watchForDecline({
		transcriptPath: tempFile,
		sessionId: 'test-session-idempotent',
		createdAt: 0,
		onDecline: () => {}
	});
	await sleep(20); // let the async start block run

	expect(() => {
		cancel();
		cancel();
		cancel();
	}).not.toThrow();
});

test('rejects paths outside ~/.claude/ and returns a no-op cancel', () => {
	let fired = false;
	const cancel = watchForDecline({
		transcriptPath: '/etc/passwd',
		sessionId: 'test-session-rejected',
		createdAt: 0,
		onDecline: () => {
			fired = true;
		}
	});

	expect(typeof cancel).toBe('function');
	expect(() => cancel()).not.toThrow();
	expect(fired).toBe(false);
});

test('ignores denial-shaped content present in the file before the watcher started', async () => {
	// Seed the file with a denial line BEFORE starting the watcher. The
	// watcher captures the starting byte offset and should only react to
	// content appended after that point.
	writeFileSync(tempFile, denialLine);

	let fired = false;
	const cancel = watchForDecline({
		transcriptPath: tempFile,
		sessionId: 'test-session-preexisting',
		createdAt: 0,
		onDecline: () => {
			fired = true;
		}
	});

	await sleep(80);
	// Trigger a no-op write so the watcher's onChange fires and we can verify
	// the seeded denial line did not retroactively trip detection.
	appendFileSync(tempFile, successLine);
	await sleep(300);

	expect(fired).toBe(false);
	cancel();
});

// ─── Codex rollouts (turn_aborted matcher) ───────────────────────────────────

// Codex fixtures live under ~/.codex/ to satisfy the extended containment
// check. Line shapes pinned verbatim from real 0.144.1 rollouts
// (codex-compatibility plan, phase 0).
function withCodexRollout(): { file: string; done: () => void } {
	const dir = mkdtempSync(path.join(os.homedir(), '.codex', '.expediter-decline-test-'));
	const file = path.join(dir, 'rollout-test.jsonl');
	writeFileSync(file, '');
	return { file, done: () => rmSync(dir, { recursive: true, force: true }) };
}

const codexAbortLine =
	JSON.stringify({
		timestamp: '2026-07-09T23:58:21.225Z',
		type: 'event_msg',
		payload: {
			type: 'turn_aborted',
			turn_id: '019f4950-d1d8-7843-9a65-9f7b868a8402',
			reason: 'interrupted',
			completed_at: 1783641501,
			duration_ms: 40005
		}
	}) + '\n';

const codexAbortedToolOutputLine =
	JSON.stringify({
		timestamp: '2026-07-09T23:58:21.219Z',
		type: 'response_item',
		payload: {
			type: 'custom_tool_call_output',
			call_id: 'call_n07TaNoheREkgeLh6JtphrPS',
			output: 'aborted by user after 36.1s'
		}
	}) + '\n';

test('fires onDecline when a codex turn_aborted line is appended', async () => {
	const rollout = withCodexRollout();
	let fired = false;
	const cancel = watchForDecline({
		transcriptPath: rollout.file,
		sessionId: 'codex-decline',
		createdAt: 0,
		onDecline: () => {
			fired = true;
		}
	});

	await sleep(80);
	appendFileSync(rollout.file, codexAbortLine);

	expect(await waitFor(() => fired)).toBe(true);
	cancel();
	rollout.done();
});

test('fires onDecline on the secondary "aborted by user" tool-output signal', async () => {
	const rollout = withCodexRollout();
	let fired = false;
	const cancel = watchForDecline({
		transcriptPath: rollout.file,
		sessionId: 'codex-decline-secondary',
		createdAt: 0,
		onDecline: () => {
			fired = true;
		}
	});

	await sleep(80);
	appendFileSync(rollout.file, codexAbortedToolOutputLine);

	expect(await waitFor(() => fired)).toBe(true);
	cancel();
	rollout.done();
});

test('does not fire on unrelated codex rollout lines', async () => {
	const rollout = withCodexRollout();
	let fired = false;
	const cancel = watchForDecline({
		transcriptPath: rollout.file,
		sessionId: 'codex-no-decline',
		createdAt: 0,
		onDecline: () => {
			fired = true;
		}
	});

	await sleep(80);
	appendFileSync(
		rollout.file,
		[
			JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'hi' } }),
			JSON.stringify({ type: 'event_msg', payload: { type: 'token_count' } }),
			JSON.stringify({
				type: 'response_item',
				payload: { type: 'function_call_output', call_id: 'x', output: 'Plan updated' }
			})
		].join('\n') + '\n'
	);
	await sleep(300);

	expect(fired).toBe(false);
	cancel();
	rollout.done();
});

test('does not fire on a turn_aborted with a non-interrupted reason', async () => {
	const rollout = withCodexRollout();
	let fired = false;
	const cancel = watchForDecline({
		transcriptPath: rollout.file,
		sessionId: 'codex-other-abort',
		createdAt: 0,
		onDecline: () => {
			fired = true;
		}
	});

	await sleep(80);
	appendFileSync(
		rollout.file,
		JSON.stringify({
			type: 'event_msg',
			payload: { type: 'turn_aborted', turn_id: 'x', reason: 'replaced' }
		}) + '\n'
	);
	await sleep(300);

	expect(fired).toBe(false);
	cancel();
	rollout.done();
});

// Matcher selection is by path segment: a codex-shaped abort line appended to
// a ~/.claude transcript must not fire (the claude matcher is active there),
// and a claude denial line in a ~/.codex rollout must not fire either.
test('matcher selection: codex abort line in a claude transcript does not fire', async () => {
	let fired = false;
	const cancel = watchForDecline({
		transcriptPath: tempFile, // ~/.claude temp from beforeEach
		sessionId: 'cross-agent-1',
		createdAt: 0,
		onDecline: () => {
			fired = true;
		}
	});

	await sleep(80);
	appendFileSync(tempFile, codexAbortLine);
	await sleep(300);

	expect(fired).toBe(false);
	cancel();
});

test('matcher selection: claude denial line in a codex rollout does not fire', async () => {
	const rollout = withCodexRollout();
	let fired = false;
	const cancel = watchForDecline({
		transcriptPath: rollout.file,
		sessionId: 'cross-agent-2',
		createdAt: 0,
		onDecline: () => {
			fired = true;
		}
	});

	await sleep(80);
	appendFileSync(rollout.file, denialLine);
	await sleep(300);

	expect(fired).toBe(false);
	cancel();
	rollout.done();
});
