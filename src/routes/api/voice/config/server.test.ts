import { test, expect } from 'bun:test';
import type { RequestEvent } from '@sveltejs/kit';
import { GET } from './+server';

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
