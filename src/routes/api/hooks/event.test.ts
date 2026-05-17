import { test, expect } from 'bun:test';
import type { RequestEvent } from '@sveltejs/kit';
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

	await callHandler({ hook_event_name: 'SessionEnd', session_id: id });

	expect(list().find((t) => t.session_id === id)).toBeUndefined();
	expect(getCachedTitle(id)).toBe('');
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
