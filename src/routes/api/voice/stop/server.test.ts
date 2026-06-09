import { test, expect } from 'bun:test';
import type { RequestEvent } from '@sveltejs/kit';
import { POST } from './+server';

// /api/voice/stop ends a /voice tap dictation. Body validation is testable here;
// the happy path (waiting out the debounce floor, then Space) is manual. stop is
// best-effort: a malformed/not-ready pane means the recording is effectively over,
// so it clears state and returns 200 injected=false rather than erroring.
function makeRequest(body: unknown, asString = false): RequestEvent {
	const request = new Request('http://localhost/api/voice/stop', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: asString ? (body as string) : JSON.stringify(body)
	});
	return { request } as unknown as RequestEvent;
}

test('POST with invalid JSON returns 400', async () => {
	const res = await POST(makeRequest('not json{', true));
	expect(res.status).toBe(400);
	const body = (await res.json()) as { ok: boolean; error: string };
	expect(body.ok).toBe(false);
	expect(body.error).toBe('invalid json');
});

test('POST with no pane field returns 400 missing-pane', async () => {
	const res = await POST(makeRequest({}));
	expect(res.status).toBe(400);
	const body = (await res.json()) as { error: string };
	expect(body.error).toBe('missing pane');
});

test('POST with a not-ready (malformed) pane clears state and returns 200 injected=false', async () => {
	const res = await POST(makeRequest({ pane: 'not-a-pane-id' }));
	expect(res.status).toBe(200);
	const body = (await res.json()) as { ok: boolean; injected: boolean };
	expect(body.ok).toBe(true);
	expect(body.injected).toBe(false);
});
