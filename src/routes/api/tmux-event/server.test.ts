import { test, expect } from 'bun:test';
import type { RequestEvent } from '@sveltejs/kit';
import { POST } from './+server';

// /api/tmux-event is the tmux-hook bridge target. It ignores the request body
// and runs a light reconcile (which swallows its own tmux errors), so the only
// testable contract here is "always answers 200 {ok:true}". The reconcile effect
// is covered by bootScan.test.ts (light mode); the live tmux path is manual.
function makeRequest(body?: string): RequestEvent {
	const request = new Request('http://localhost/api/tmux-event', {
		method: 'POST',
		...(body !== undefined ? { body } : {})
	});
	return { request } as unknown as RequestEvent;
}

test('POST returns 200 {ok:true} with no body', async () => {
	const res = await POST(makeRequest());
	expect(res.status).toBe(200);
	expect((await res.json()) as { ok: boolean }).toEqual({ ok: true });
});

test('POST ignores any body and still returns 200 {ok:true}', async () => {
	const res = await POST(makeRequest('garbage-not-json'));
	expect(res.status).toBe(200);
	expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
});
