import { test, expect } from 'bun:test';
import type { RequestEvent } from '@sveltejs/kit';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { POST } from './event/+server';
import {
	getCachedTitle,
	setCachedTitle,
	deleteSessionTopic,
	list,
	remove,
	shouldRefresh
} from '$lib/ticketStore';

// Unique session_id per test so module-level state doesn't leak.
let testCounter = 0;
const nextId = (): string => `hook-test-${++testCounter}`;

function makeRequest(payload: unknown): RequestEvent {
	const request = new Request('http://localhost/api/hooks/event', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(payload)
	});
	return { request } as unknown as RequestEvent;
}

async function callHandler(payload: unknown): Promise<{ status: number; body: unknown }> {
	const response = await POST(makeRequest(payload));
	return { status: response.status, body: await response.json() };
}

test('UserPromptSubmit increments the session counter', async () => {
	const id = nextId();
	await callHandler({ hook_event_name: 'UserPromptSubmit', session_id: id });
	expect(shouldRefresh(id, 1)).toBe(true); // counter is 1, 1 % 1 === 0
	deleteSessionTopic(id);
});

test('UserPromptSubmit with a failing transcript read keeps the cache empty', async () => {
	const id = nextId();
	// UserPromptSubmit now triggers maybeRefreshTopic directly. With a bad
	// transcript_path the read fails, summarize never runs, and setCachedTitle
	// is not called — cache stays empty across repeated hits.
	for (let i = 0; i < 4; i++) {
		await callHandler({
			hook_event_name: 'UserPromptSubmit',
			session_id: id,
			transcript_path: '/nonexistent/path'
		});
	}
	expect(getCachedTitle(id)).toBe('');
	deleteSessionTopic(id);
});

test('PostToolUse does not increment the counter (would over-trigger)', async () => {
	const id = nextId();
	await callHandler({ hook_event_name: 'PostToolUse', session_id: id });
	// PostToolUse routes through CLEAR_EVENTS and returns before shouldRefresh
	// is reached in production; assert the cache stayed empty as a side-effect
	// check that no summarize ran.
	expect(getCachedTitle(id)).toBe('');
});

test('PostToolUseFailure does not increment the counter', async () => {
	const id = nextId();
	await callHandler({ hook_event_name: 'PostToolUseFailure', session_id: id });
	expect(getCachedTitle(id)).toBe('');
});

test('Stop with a cached title upserts a ticket carrying that title', async () => {
	const id = nextId();
	setCachedTitle(id, 'refactored aggregator');
	const result = await callHandler({
		hook_event_name: 'Stop',
		session_id: id,
		tmux_pane: '%1',
		cwd: '/tmp/proj'
	});
	expect(result.status).toBe(200);
	const ticket = list().find((t) => t.session_id === id);
	expect(ticket?.title).toBe('refactored aggregator');
	expect(ticket?.event_type).toBe('Stop');
	remove(id);
	deleteSessionTopic(id);
});

test('Stop with no cached title upserts a ticket with title === ""', async () => {
	const id = nextId();
	const result = await callHandler({
		hook_event_name: 'Stop',
		session_id: id,
		tmux_pane: '%1',
		cwd: '/tmp/proj'
	});
	expect(result.status).toBe(200);
	const ticket = list().find((t) => t.session_id === id);
	expect(ticket?.title).toBe('');
	remove(id);
});

test('PermissionRequest carries the cached title and the right event_type', async () => {
	const id = nextId();
	setCachedTitle(id, 'allow rm node_modules?');
	await callHandler({
		hook_event_name: 'PermissionRequest',
		session_id: id,
		tmux_pane: '%1',
		cwd: '/tmp/proj'
	});
	const ticket = list().find((t) => t.session_id === id);
	expect(ticket?.title).toBe('allow rm node_modules?');
	expect(ticket?.event_type).toBe('PermissionRequest');
	remove(id);
	deleteSessionTopic(id);
});

test('SessionEnd clears the per-session topic state and removes any ticket', async () => {
	const id = nextId();
	// Stage some state.
	setCachedTitle(id, 'will be wiped');
	await callHandler({
		hook_event_name: 'Stop',
		session_id: id,
		tmux_pane: '%1',
		cwd: '/tmp/proj'
	});
	expect(list().find((t) => t.session_id === id)).toBeDefined();
	expect(getCachedTitle(id)).toBe('will be wiped');

	const result = await callHandler({ hook_event_name: 'SessionEnd', session_id: id });

	expect((result.body as { action?: string }).action).toBe('cleared');
	expect(list().find((t) => t.session_id === id)).toBeUndefined();
	expect(getCachedTitle(id)).toBe('');
});

test('UserPromptSubmit marks an existing ticket working instead of removing it', async () => {
	const id = nextId();
	await callHandler({
		hook_event_name: 'Stop',
		session_id: id,
		tmux_pane: '%1',
		cwd: '/tmp/proj'
	});
	expect(list().find((t) => t.session_id === id)?.working).toBe(false);

	const result = await callHandler({ hook_event_name: 'UserPromptSubmit', session_id: id });
	expect((result.body as { action?: string }).action).toBe('marked_working');

	const t = list().find((t) => t.session_id === id);
	expect(t).toBeDefined();
	expect(t?.working).toBe(true);
	remove(id);
	deleteSessionTopic(id);
});

test('PostToolUse marks an existing ticket working', async () => {
	const id = nextId();
	await callHandler({
		hook_event_name: 'Stop',
		session_id: id,
		tmux_pane: '%1',
		cwd: '/tmp/proj'
	});
	const result = await callHandler({ hook_event_name: 'PostToolUse', session_id: id });
	expect((result.body as { action?: string }).action).toBe('marked_working');
	expect(list().find((t) => t.session_id === id)?.working).toBe(true);
	remove(id);
});

test('PostToolUseFailure marks an existing ticket working', async () => {
	const id = nextId();
	await callHandler({
		hook_event_name: 'Stop',
		session_id: id,
		tmux_pane: '%1',
		cwd: '/tmp/proj'
	});
	const result = await callHandler({ hook_event_name: 'PostToolUseFailure', session_id: id });
	expect((result.body as { action?: string }).action).toBe('marked_working');
	expect(list().find((t) => t.session_id === id)?.working).toBe(true);
	remove(id);
});

test('A Stop after UserPromptSubmit lifts the working ticket back to idle', async () => {
	const id = nextId();
	await callHandler({
		hook_event_name: 'Stop',
		session_id: id,
		tmux_pane: '%1',
		cwd: '/tmp/proj'
	});
	await callHandler({ hook_event_name: 'UserPromptSubmit', session_id: id });
	expect(list().find((t) => t.session_id === id)?.working).toBe(true);

	await callHandler({
		hook_event_name: 'Stop',
		session_id: id,
		tmux_pane: '%1',
		cwd: '/tmp/proj'
	});
	const t = list().find((t) => t.session_id === id);
	expect(t?.working).toBe(false);
	expect(t?.event_type).toBe('Stop');
	remove(id);
	deleteSessionTopic(id);
});

test('missing hook_event_name returns 400', async () => {
	const result = await callHandler({ session_id: nextId() });
	expect(result.status).toBe(400);
});

test('missing session_id returns 400', async () => {
	const result = await callHandler({ hook_event_name: 'Stop' });
	expect(result.status).toBe(400);
});

test('Stop without tmux_pane returns 400', async () => {
	const result = await callHandler({
		hook_event_name: 'Stop',
		session_id: nextId()
	});
	expect(result.status).toBe(400);
});

test('unknown hook event returns 200 with action="ignored"', async () => {
	const result = await callHandler({
		hook_event_name: 'NotARealEvent',
		session_id: nextId(),
		tmux_pane: '%1'
	});
	expect(result.status).toBe(200);
	expect((result.body as { action?: string }).action).toBe('ignored');
});

test('invalid JSON body returns 400', async () => {
	const request = new Request('http://localhost/api/hooks/event', {
		method: 'POST',
		body: 'not json'
	});
	const response = await POST({ request } as unknown as RequestEvent);
	expect(response.status).toBe(400);
});

// Integration: PermissionRequest kicks off the decline watcher, and a denial
// line appended to the real transcript file lifts the ticket back to a
// Stop+idle resting state via resolveDeclineIfMatch (declined permission is
// resolved, not still working). The transcript path must live under ~/.claude/
// to pass the watcher's containment check. Cleanup runs after the assertions
// so the watcher's cancel (on detection) lands before unlink.
test('PermissionRequest + appended denial line lifts the ticket to Stop+idle via the watcher', async () => {
	const tempDir = mkdtempSync(path.join(os.homedir(), '.claude', '.expediter-test-'));
	const tempFile = path.join(tempDir, 'transcript.jsonl');
	writeFileSync(tempFile, '');

	const id = nextId();
	const result = await callHandler({
		hook_event_name: 'PermissionRequest',
		session_id: id,
		tmux_pane: '%1',
		cwd: '/tmp/proj',
		transcript_path: tempFile
	});
	expect(result.status).toBe(200);
	expect(list().find((t) => t.session_id === id)?.event_type).toBe('PermissionRequest');

	// Give the watcher's async start block time to capture the starting offset
	// and attach fs.watch before we append.
	await new Promise((r) => setTimeout(r, 80));

	const denialLine =
		JSON.stringify({
			type: 'user',
			message: {
				content: [
					{
						type: 'tool_result',
						is_error: true,
						content: "The user doesn't want to proceed with this tool use."
					}
				]
			}
		}) + '\n';
	appendFileSync(tempFile, denialLine);

	const start = Date.now();
	while (Date.now() - start < 700) {
		if (list().find((t) => t.session_id === id)?.event_type === 'Stop') break;
		await new Promise((r) => setTimeout(r, 20));
	}

	const t = list().find((t) => t.session_id === id);
	expect(t).toBeDefined();
	expect(t?.event_type).toBe('Stop');
	expect(t?.working).toBe(false);

	rmSync(tempDir, { recursive: true, force: true });
	remove(id);
	deleteSessionTopic(id);
});

// A subsequent event for the same session_id must cancel the decline watcher.
// Otherwise an approved (not declined) PermissionRequest leaks a 1h watcher.
// We verify this by posting a PR + a follow-up event, then appending a denial
// line — the cancelled watcher should not fire, so the ticket's event_type
// stays at whatever the follow-up set it to instead of being lifted to Stop.
test('A subsequent event cancels the decline watcher (approve case)', async () => {
	const tempDir = mkdtempSync(path.join(os.homedir(), '.claude', '.expediter-test-'));
	const tempFile = path.join(tempDir, 'transcript.jsonl');
	writeFileSync(tempFile, '');

	const id = nextId();
	await callHandler({
		hook_event_name: 'PermissionRequest',
		session_id: id,
		tmux_pane: '%1',
		cwd: '/tmp/proj',
		transcript_path: tempFile
	});

	// Wait for the watcher to attach before superseding it.
	await new Promise((r) => setTimeout(r, 80));

	// Approve-then-process is signalled by PostToolUse — this should cancel the
	// PR's decline watcher.
	const followUp = await callHandler({ hook_event_name: 'PostToolUse', session_id: id });
	expect((followUp.body as { action?: string }).action).toBe('marked_working');

	// Now append a denial line that the (cancelled) watcher would otherwise
	// detect. After waiting, the ticket must still be in the post-follow-up
	// state — not lifted to Stop by a stale watcher.
	appendFileSync(
		tempFile,
		JSON.stringify({
			type: 'user',
			message: {
				content: [
					{
						type: 'tool_result',
						is_error: true,
						content: "The user doesn't want to proceed with this tool use."
					}
				]
			}
		}) + '\n'
	);
	await new Promise((r) => setTimeout(r, 250));

	const t = list().find((t) => t.session_id === id);
	expect(t).toBeDefined();
	expect(t?.event_type).toBe('PermissionRequest');
	expect(t?.working).toBe(true);

	rmSync(tempDir, { recursive: true, force: true });
	remove(id);
	deleteSessionTopic(id);
});

// Confirm the wiring is gated to PermissionRequest only: a Stop event for the
// same kind of payload should NOT spawn a watcher, so a later denial line in
// the file should not affect the Stop ticket.
test('Stop does not spawn a watcher (denial line in transcript has no effect)', async () => {
	const tempDir = mkdtempSync(path.join(os.homedir(), '.claude', '.expediter-test-'));
	const tempFile = path.join(tempDir, 'transcript.jsonl');
	writeFileSync(tempFile, '');

	const id = nextId();
	await callHandler({
		hook_event_name: 'Stop',
		session_id: id,
		tmux_pane: '%1',
		cwd: '/tmp/proj',
		transcript_path: tempFile
	});
	expect(list().find((t) => t.session_id === id)).toBeDefined();

	await new Promise((r) => setTimeout(r, 80));
	appendFileSync(
		tempFile,
		JSON.stringify({
			type: 'user',
			message: {
				content: [
					{
						type: 'tool_result',
						is_error: true,
						content: "The user doesn't want to proceed with this tool use."
					}
				]
			}
		}) + '\n'
	);
	await new Promise((r) => setTimeout(r, 200));

	expect(list().find((t) => t.session_id === id)).toBeDefined();

	rmSync(tempDir, { recursive: true, force: true });
	remove(id);
	deleteSessionTopic(id);
});
