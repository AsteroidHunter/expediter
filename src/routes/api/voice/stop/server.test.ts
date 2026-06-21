import { test, expect, afterEach } from 'bun:test';
import type { RequestEvent } from '@sveltejs/kit';
import { POST } from './+server';
import { markVoiceStart, clearVoice, voiceElapsedMs } from '$lib/server/voice';

// /api/voice/stop ends a /voice tap dictation. Body validation and the active-
// recording gate are testable here; the injection happy path (waiting out the
// debounce floor, then Space) is manual. The gate runs BEFORE any tmux shell-out:
// a stop with no daemon-recorded start is refused (409) because tap's Space is a
// toggle and a blind Space on an idle pane would START a dictation. Past the gate,
// stop is best-effort: a malformed/not-ready pane means the recording is
// effectively over, so it clears state and returns 200 injected=false.
function makeRequest(body: unknown, asString = false): RequestEvent {
	const request = new Request('http://localhost/api/voice/stop', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: asString ? (body as string) : JSON.stringify(body)
	});
	return { request } as unknown as RequestEvent;
}

// The active map is module state shared across the daemon process (and the test
// run) — leave it clean so other test files can't observe these panes.
const TEST_PANES = ['not-a-pane-id', '%999901'];
afterEach(() => {
	for (const pane of TEST_PANES) clearVoice(pane);
});

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

test('POST with no active recording is refused 409 without injecting', async () => {
	// A valid-shaped pane id, but no markVoiceStart: the gate must refuse before
	// any readiness check or send-keys could run (a blind Space would START a
	// dictation on an idle pane — the on-device inversion bug).
	const res = await POST(makeRequest({ pane: '%999901' }));
	expect(res.status).toBe(409);
	const body = (await res.json()) as { ok: boolean; injected: boolean; error: string };
	expect(body.ok).toBe(false);
	expect(body.injected).toBe(false);
	expect(body.error).toBe('no active /voice recording for this pane');
});

test('POST with an active recording on a not-ready pane clears state, 200 injected=false', async () => {
	// Recording on record, but the pane is malformed → readiness fails without a
	// shell-out → best-effort branch: flag cleared, nothing injected, success.
	markVoiceStart('not-a-pane-id', Date.now() - 5000);
	const res = await POST(makeRequest({ pane: 'not-a-pane-id' }));
	expect(res.status).toBe(200);
	const body = (await res.json()) as { ok: boolean; injected: boolean };
	expect(body.ok).toBe(true);
	expect(body.injected).toBe(false);
	expect(voiceElapsedMs('not-a-pane-id')).toBeNull();
});
