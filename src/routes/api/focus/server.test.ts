import { test, expect } from 'bun:test';
import type { RequestEvent } from '@sveltejs/kit';
import { POST } from './+server';

// /api/focus is the dock's tap-to-focus endpoint. The body validation is the
// only path testable without shelling out to tmux/AppleScript; we cover the
// 400 / 410 / 500 branches by request shape and pane-id validity. The happy
// path requires a live tmux server and is exercised manually.

function makeRequest(body: unknown, asString = false): RequestEvent {
	const request = new Request('http://localhost/api/focus', {
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
	const body = (await res.json()) as { ok: boolean; error: string };
	expect(body.error).toBe('missing pane');
});

test('POST with empty pane string returns 400 missing-pane', async () => {
	const res = await POST(makeRequest({ pane: '' }));
	expect(res.status).toBe(400);
	const body = (await res.json()) as { ok: boolean; error: string };
	expect(body.error).toBe('missing pane');
});

// focusPane rejects ids that don't match /^%[0-9]+$/ with a FocusError; the
// route handler maps FocusError → 410 (Gone), distinguishing "the pane doesn't
// exist / was malformed" from a 500 internal failure.
test('POST with malformed pane id surfaces as 410 (FocusError mapped)', async () => {
	const res = await POST(makeRequest({ pane: 'not-a-pane-id' }));
	expect(res.status).toBe(410);
	const body = (await res.json()) as { ok: boolean; error: string };
	expect(body.ok).toBe(false);
	expect(body.error).toContain('invalid pane');
});
