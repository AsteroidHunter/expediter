import { test, expect, afterEach } from 'bun:test';
import type { RequestEvent } from '@sveltejs/kit';
import { POST } from './+server';
import { markVoiceStart, clearVoice, voiceElapsedMs } from '$lib/server/voice';

// /api/voice/cancel aborts a /voice dictation without submitting by sending Escape
// (Claude's /voice discard key). Body validation and the no-active-recording gate are
// testable here; the injection happy path is manual. Unlike stop, no-active-recording
// is SUCCESS (cancel's intent — "nothing recording" — already holds), and the injection
// is skipped so a stray Escape can't disturb an idle pane. Past the gate, cancel is
// best-effort: a malformed/not-ready pane clears state and returns 200 injected=false
// rather than erroring.
function makeRequest(body: unknown, asString = false): RequestEvent {
	const request = new Request('http://localhost/api/voice/cancel', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: asString ? (body as string) : JSON.stringify(body)
	});
	return { request } as unknown as RequestEvent;
}

const TEST_PANES = ['not-a-pane-id', '%999902'];
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

test('POST with no active recording succeeds without injecting (200 injected=false)', async () => {
	// Valid-shaped pane, nothing on record: the gate returns success before any
	// readiness check — an injected Escape here could only disturb an idle pane.
	const res = await POST(makeRequest({ pane: '%999902' }));
	expect(res.status).toBe(200);
	const body = (await res.json()) as { ok: boolean; injected: boolean };
	expect(body.ok).toBe(true);
	expect(body.injected).toBe(false);
});

test('POST with an active recording on a not-ready pane clears state, 200 injected=false', async () => {
	markVoiceStart('not-a-pane-id', Date.now() - 5000);
	const res = await POST(makeRequest({ pane: 'not-a-pane-id' }));
	expect(res.status).toBe(200);
	const body = (await res.json()) as { ok: boolean; injected: boolean };
	expect(body.ok).toBe(true);
	expect(body.injected).toBe(false);
	expect(voiceElapsedMs('not-a-pane-id')).toBeNull();
});
