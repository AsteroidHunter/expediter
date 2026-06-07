import { test, expect } from 'bun:test';
import type { RequestEvent } from '@sveltejs/kit';
import { POST } from './+server';

// /api/attach is the Detached page's tap-to-attach endpoint. As with /api/focus,
// only the body-validation and gone-pane branches are testable without a live
// tmux server + Terminal.app; the happy path (spawning a window) is manual.
function makeRequest(body: unknown, asString = false): RequestEvent {
	const request = new Request('http://localhost/api/attach', {
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

// attachSession rejects ids that don't match /^%[0-9]+$/ with a FocusError; the
// route maps FocusError → 410 (Gone), distinguishing a missing/malformed pane
// from a 500 internal failure — same contract as /api/focus.
test('POST with malformed pane id surfaces as 410 (FocusError mapped)', async () => {
	const res = await POST(makeRequest({ pane: 'not-a-pane-id' }));
	expect(res.status).toBe(410);
	const body = (await res.json()) as { ok: boolean; error: string };
	expect(body.ok).toBe(false);
	expect(body.error).toContain('invalid pane');
});
