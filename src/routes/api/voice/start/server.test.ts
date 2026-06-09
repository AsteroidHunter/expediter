import { test, expect } from 'bun:test';
import type { RequestEvent } from '@sveltejs/kit';
import { POST } from './+server';

// /api/voice/start begins a /voice tap dictation. Only the body-validation and
// not-ready branches are testable without a live tmux server + Claude pane; the
// happy path (injecting C-u + Space) is exercised manually. A malformed pane id is
// rejected by the tier-1 readiness guard before any shell-out, so it surfaces as
// 409 not-ready rather than reaching tmux or `claude --version`.
function makeRequest(body: unknown, asString = false): RequestEvent {
	const request = new Request('http://localhost/api/voice/start', {
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

test('POST with empty pane string returns 400 missing-pane', async () => {
	const res = await POST(makeRequest({ pane: '' }));
	expect(res.status).toBe(400);
	const body = (await res.json()) as { error: string };
	expect(body.error).toBe('missing pane');
});

test('POST with a malformed pane id is rejected as 409 not-ready', async () => {
	const res = await POST(makeRequest({ pane: 'not-a-pane-id' }));
	expect(res.status).toBe(409);
	const body = (await res.json()) as { ok: boolean; ready: boolean; error: string };
	expect(body.ok).toBe(false);
	expect(body.ready).toBe(false);
	expect(body.error).toContain('invalid pane');
});
