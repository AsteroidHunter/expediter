import { test, expect } from 'bun:test';
import type { RequestEvent } from '@sveltejs/kit';
import { POST } from './+server';
import { upsert, remove } from '$lib/ticketStore';

// /api/focus is the dock's tap-to-focus endpoint, ticket-scoped since D12:
// the phone sends {session_id} and the daemon resolves the pane (and, for
// remote-tmux tickets, the whole remote flow) from the ticket. Legacy
// {pane}-only bodies are honored only when exactly one ticket sits on that
// pane. The body-validation and resolution branches are testable without
// tmux; the happy path needs a live tmux server and is exercised in the
// cross-machine pass.

function makeRequest(body: unknown, asString = false): RequestEvent {
	const request = new Request('http://localhost/api/focus', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: asString ? (body as string) : JSON.stringify(body)
	});
	return { request } as unknown as RequestEvent;
}

function seedTicket(session_id: string, tmux_pane: string, remote_pane?: string): void {
	upsert({
		session_id,
		tmux_pane,
		cwd: '/x',
		title: '',
		event_type: 'Stop',
		created_at: Date.now(),
		remote: remote_pane !== undefined,
		...(remote_pane ? { remote_pane } : {})
	});
}

test('POST with invalid JSON returns 400', async () => {
	const res = await POST(makeRequest('not json{', true));
	expect(res.status).toBe(400);
	const body = (await res.json()) as { ok: boolean; error: string };
	expect(body.ok).toBe(false);
	expect(body.error).toBe('invalid json');
});

test('POST with neither session_id nor pane returns 400', async () => {
	const res = await POST(makeRequest({}));
	expect(res.status).toBe(400);
	const body = (await res.json()) as { ok: boolean; error: string };
	expect(body.error).toBe('missing session_id');
});

test('POST with empty pane string returns 400 (treated as absent)', async () => {
	const res = await POST(makeRequest({ pane: '' }));
	expect(res.status).toBe(400);
	const body = (await res.json()) as { ok: boolean; error: string };
	expect(body.error).toBe('missing session_id');
});

test('POST with an unknown session_id returns 410', async () => {
	const res = await POST(makeRequest({ session_id: 'focus-nope' }));
	expect(res.status).toBe(410);
	const body = (await res.json()) as { ok: boolean; error: string };
	expect(body.ok).toBe(false);
	expect(body.error).toContain('no ticket');
});

test('legacy {pane} body with no ticket on that pane returns 410', async () => {
	const res = await POST(makeRequest({ pane: 'not-a-pane-id' }));
	expect(res.status).toBe(410);
	const body = (await res.json()) as { ok: boolean; error: string };
	expect(body.ok).toBe(false);
	expect(body.error).toContain('no ticket');
});

test('legacy {pane} body with two tickets on the pane refuses to guess (409)', async () => {
	seedTicket('focus-sib-a', '%9931', '%3');
	seedTicket('focus-sib-b', '%9931', '%7');
	try {
		const res = await POST(makeRequest({ pane: '%9931' }));
		expect(res.status).toBe(409);
		const body = (await res.json()) as { ok: boolean; error: string };
		expect(body.ok).toBe(false);
	} finally {
		remove('focus-sib-a');
		remove('focus-sib-b');
	}
});

// A resolved local ticket whose pane no longer exists (or, as here, whose id
// is synthetic) surfaces focusPane's FocusError as 410 — same mapping the
// pane-based route had.
test('a resolved ticket with a dead pane surfaces as 410 (FocusError mapped)', async () => {
	seedTicket('focus-dead-pane', '%999432');
	try {
		const res = await POST(makeRequest({ session_id: 'focus-dead-pane' }));
		expect(res.status).toBe(410);
		const body = (await res.json()) as { ok: boolean; error: string };
		expect(body.ok).toBe(false);
	} finally {
		remove('focus-dead-pane');
	}
});
