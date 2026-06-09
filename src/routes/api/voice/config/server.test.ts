import { test, expect } from 'bun:test';
import type { RequestEvent } from '@sveltejs/kit';
import { GET, POST } from './+server';

// /api/voice/config tells the frontend which STT backend the gesture should drive.
// It reads the user's config fresh (defaulting to 'voice'); we just pin the
// response shape and that it only ever returns one of the two valid backends —
// never a secret.
test('GET returns 200 with a valid backend and nothing else', async () => {
	const res = await GET({} as RequestEvent);
	expect(res.status).toBe(200);
	const body = (await res.json()) as Record<string, unknown>;
	expect(['baseten', 'voice']).toContain(body.backend);
	// Must not leak the key or model id to the client.
	expect(Object.keys(body)).toEqual(['backend']);
});

// POST validation paths only — the happy path writes the real ~/.expediter
// config.json (the route can't take an injected path), so the write itself is
// covered by setSttBackend's unit tests against a temp file instead.
function makePost(body: unknown, asString = false): RequestEvent {
	const request = new Request('http://localhost/api/voice/config', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: asString ? (body as string) : JSON.stringify(body)
	});
	return { request } as unknown as RequestEvent;
}

test('POST with invalid JSON returns 400', async () => {
	const res = await POST(makePost('not json{', true));
	expect(res.status).toBe(400);
	const body = (await res.json()) as { error: string };
	expect(body.error).toBe('invalid json');
});

test('POST with an unknown backend returns 400 without writing', async () => {
	const res = await POST(makePost({ backend: 'deepgram' }));
	expect(res.status).toBe(400);
	const body = (await res.json()) as { error: string };
	expect(body.error).toBe('invalid backend');
});

test('POST with a missing backend returns 400', async () => {
	const res = await POST(makePost({}));
	expect(res.status).toBe(400);
});
