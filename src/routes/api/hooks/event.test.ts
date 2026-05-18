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

test('UserPromptSubmit at counter < N does not call summarize (no refresh fires)', async () => {
	const id = nextId();
	// 4 hits with interval=5 — none should reach the refresh path. We assert by
	// verifying the cache stays empty (no setCachedTitle has run).
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
	// No counter entry → shouldRefresh returns false (counter === 0 guard).
	expect(shouldRefresh(id, 1)).toBe(false);
});

test('PostToolUseFailure does not increment the counter', async () => {
	const id = nextId();
	await callHandler({ hook_event_name: 'PostToolUseFailure', session_id: id });
	expect(shouldRefresh(id, 1)).toBe(false);
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

test('UserPromptSubmit marks an existing ticket inactive instead of removing it', async () => {
	const id = nextId();
	await callHandler({
		hook_event_name: 'Stop',
		session_id: id,
		tmux_pane: '%1',
		cwd: '/tmp/proj'
	});
	expect(list().find((t) => t.session_id === id)?.inactive).toBe(false);

	const result = await callHandler({ hook_event_name: 'UserPromptSubmit', session_id: id });
	expect((result.body as { action?: string }).action).toBe('marked_inactive');

	const t = list().find((t) => t.session_id === id);
	expect(t).toBeDefined();
	expect(t?.inactive).toBe(true);
	remove(id);
	deleteSessionTopic(id);
});

test('PostToolUse marks an existing ticket inactive', async () => {
	const id = nextId();
	await callHandler({
		hook_event_name: 'Stop',
		session_id: id,
		tmux_pane: '%1',
		cwd: '/tmp/proj'
	});
	const result = await callHandler({ hook_event_name: 'PostToolUse', session_id: id });
	expect((result.body as { action?: string }).action).toBe('marked_inactive');
	expect(list().find((t) => t.session_id === id)?.inactive).toBe(true);
	remove(id);
});

test('PostToolUseFailure marks an existing ticket inactive', async () => {
	const id = nextId();
	await callHandler({
		hook_event_name: 'Stop',
		session_id: id,
		tmux_pane: '%1',
		cwd: '/tmp/proj'
	});
	const result = await callHandler({ hook_event_name: 'PostToolUseFailure', session_id: id });
	expect((result.body as { action?: string }).action).toBe('marked_inactive');
	expect(list().find((t) => t.session_id === id)?.inactive).toBe(true);
	remove(id);
});

test('A Stop after UserPromptSubmit reactivates the inactive ticket', async () => {
	const id = nextId();
	await callHandler({
		hook_event_name: 'Stop',
		session_id: id,
		tmux_pane: '%1',
		cwd: '/tmp/proj'
	});
	await callHandler({ hook_event_name: 'UserPromptSubmit', session_id: id });
	expect(list().find((t) => t.session_id === id)?.inactive).toBe(true);

	await callHandler({
		hook_event_name: 'Stop',
		session_id: id,
		tmux_pane: '%1',
		cwd: '/tmp/proj'
	});
	const t = list().find((t) => t.session_id === id);
	expect(t?.inactive).toBe(false);
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
// line appended to the real transcript file sinks the ticket into the inactive
// tier (perpetual model: handled, not gone). The transcript path must live
// under ~/.claude/ to pass the watcher's containment check. Cleanup runs after
// the assertions so the watcher's cancel (on detection) lands before unlink.
test('PermissionRequest + appended denial line marks the ticket inactive via the watcher', async () => {
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
	expect(list().find((t) => t.session_id === id)?.inactive).toBe(false);

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
		if (list().find((t) => t.session_id === id)?.inactive === true) break;
		await new Promise((r) => setTimeout(r, 20));
	}

	const t = list().find((t) => t.session_id === id);
	expect(t).toBeDefined();
	expect(t?.inactive).toBe(true);

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
