import { test, expect, beforeEach, afterEach } from 'bun:test';
import { handle } from './hooks.server';
import { __setTokenForTesting } from './lib/token';

// Known token used for all gate tests. 22 base64url chars.
const TEST_TOKEN = 'AAAAAAAAAAAAAAAAAAAAAA';
const WRONG_TOKEN = 'BBBBBBBBBBBBBBBBBBBBBB';

beforeEach(() => {
	__setTokenForTesting(TEST_TOKEN);
});

afterEach(() => {
	__setTokenForTesting(null);
});

type EventShim = {
	request: Request;
	url: URL;
	getClientAddress: () => string;
};

function makeEvent(opts: {
	url: string;
	method?: string;
	headers?: Record<string, string>;
	ip?: string;
}): EventShim {
	const url = new URL(opts.url);
	const headers = new Headers({ host: url.host, ...(opts.headers ?? {}) });
	const ip = opts.ip ?? '192.168.1.50';
	const request = new Request(url, { method: opts.method ?? 'GET', headers });
	return {
		request,
		url,
		getClientAddress: () => ip
	};
}

// Resolve stub returns 200 OK so tests can distinguish "gate passed" from
// "gate rejected" (403). The real resolve dispatches to a route handler;
// here we substitute a no-op success.
const resolveOK = async (): Promise<Response> => new Response(null, { status: 200 });

// Convenience wrapper — gate's handle signature requires the SvelteKit Handle
// shape; the shim is sufficient because handle only touches request.headers,
// url.pathname, url.searchParams, getClientAddress(), and calls resolve().
async function runGate(event: EventShim): Promise<Response> {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	return handle({ event: event as any, resolve: resolveOK as any });
}

// --- page + static (public) ---

test('GET / with no token → 200 (page is public)', async () => {
	const res = await runGate(makeEvent({ url: 'http://192.168.1.50:5179/' }));
	expect(res.status).toBe(200);
});

test('GET /_app/start.js with no token → 200 (static is public)', async () => {
	const res = await runGate(makeEvent({ url: 'http://192.168.1.50:5179/_app/start.js' }));
	expect(res.status).toBe(200);
});

// --- /api/focus (token-gated) ---

test('POST /api/focus with no token → 403', async () => {
	const res = await runGate(makeEvent({ url: 'http://192.168.1.50:5179/api/focus', method: 'POST' }));
	expect(res.status).toBe(403);
});

test('POST /api/focus with wrong token → 403', async () => {
	const res = await runGate(
		makeEvent({
			url: 'http://192.168.1.50:5179/api/focus',
			method: 'POST',
			headers: { 'x-expediter-token': WRONG_TOKEN }
		})
	);
	expect(res.status).toBe(403);
});

test('POST /api/focus with correct header token → 200', async () => {
	const res = await runGate(
		makeEvent({
			url: 'http://192.168.1.50:5179/api/focus',
			method: 'POST',
			headers: { 'x-expediter-token': TEST_TOKEN }
		})
	);
	expect(res.status).toBe(200);
});

test('GET /api/focus?t=<correct> → 403 (query-token only valid on /api/stream)', async () => {
	const res = await runGate(
		makeEvent({ url: `http://192.168.1.50:5179/api/focus?t=${TEST_TOKEN}` })
	);
	expect(res.status).toBe(403);
});

// --- /api/stream (query token + header fallback) ---

test('GET /api/stream?t=<correct> → 200', async () => {
	const res = await runGate(
		makeEvent({ url: `http://192.168.1.50:5179/api/stream?t=${TEST_TOKEN}` })
	);
	expect(res.status).toBe(200);
});

test('GET /api/stream with no t and no header → 403', async () => {
	const res = await runGate(makeEvent({ url: 'http://192.168.1.50:5179/api/stream' }));
	expect(res.status).toBe(403);
});

test('GET /api/stream header+query both supplied → header wins', async () => {
	// Header has correct token; query has wrong token. Header precedence → 200.
	const res = await runGate(
		makeEvent({
			url: `http://192.168.1.50:5179/api/stream?t=${WRONG_TOKEN}`,
			headers: { 'x-expediter-token': TEST_TOKEN }
		})
	);
	expect(res.status).toBe(200);
});

// --- /api/ping (token-gated probe) ---

test('GET /api/ping with no token → 403', async () => {
	const res = await runGate(makeEvent({ url: 'http://192.168.1.50:5179/api/ping' }));
	expect(res.status).toBe(403);
});

test('GET /api/ping with correct token → 200', async () => {
	const res = await runGate(
		makeEvent({
			url: 'http://192.168.1.50:5179/api/ping',
			headers: { 'x-expediter-token': TEST_TOKEN }
		})
	);
	expect(res.status).toBe(200);
});

// --- /api/hooks/event (loopback bypass) ---

test('POST /api/hooks/event from 127.0.0.1 with no token → 200 (loopback bypass)', async () => {
	const res = await runGate(
		makeEvent({ url: 'http://127.0.0.1:5179/api/hooks/event', method: 'POST', ip: '127.0.0.1' })
	);
	expect(res.status).toBe(200);
});

test('POST /api/hooks/event from ::1 with no token → 200 (loopback bypass)', async () => {
	const res = await runGate(
		makeEvent({ url: 'http://[::1]:5179/api/hooks/event', method: 'POST', ip: '::1' })
	);
	expect(res.status).toBe(200);
});

test('POST /api/hooks/event from non-loopback with no token → 403', async () => {
	const res = await runGate(
		makeEvent({ url: 'http://192.168.1.50:5179/api/hooks/event', method: 'POST', ip: '192.168.1.50' })
	);
	expect(res.status).toBe(403);
});

test('POST /api/hooks/event from non-loopback with correct token → 200', async () => {
	// Non-loopback callers fall through the bypass and hit the standard token check.
	const res = await runGate(
		makeEvent({
			url: 'http://192.168.1.50:5179/api/hooks/event',
			method: 'POST',
			ip: '192.168.1.50',
			headers: { 'x-expediter-token': TEST_TOKEN }
		})
	);
	expect(res.status).toBe(200);
});

test('POST /api/focus from 127.0.0.1 with no token → 403 (loopback bypass does NOT extend to focus)', async () => {
	const res = await runGate(
		makeEvent({ url: 'http://127.0.0.1:5179/api/focus', method: 'POST', ip: '127.0.0.1' })
	);
	expect(res.status).toBe(403);
});

// --- host header check ---

test('Host attacker.com:5179 → 403', async () => {
	const res = await runGate(
		makeEvent({ url: 'http://192.168.1.50:5179/', headers: { host: 'attacker.com:5179' } })
	);
	expect(res.status).toBe(403);
});

test('Host 192.168.1.50:5179 → passes host check (page loads)', async () => {
	const res = await runGate(makeEvent({ url: 'http://192.168.1.50:5179/' }));
	expect(res.status).toBe(200);
});

test('Host 8.8.8.8:5179 → 403 (not RFC1918)', async () => {
	const res = await runGate(
		makeEvent({ url: 'http://192.168.1.50:5179/', headers: { host: '8.8.8.8:5179' } })
	);
	expect(res.status).toBe(403);
});

test('Host 10.0.0.5:5179 → passes (10.0.0.0/8 RFC1918)', async () => {
	const res = await runGate(
		makeEvent({ url: 'http://192.168.1.50:5179/', headers: { host: '10.0.0.5:5179' } })
	);
	expect(res.status).toBe(200);
});

test('Host 172.20.5.10:5179 → passes (172.16.0.0/12 RFC1918)', async () => {
	const res = await runGate(
		makeEvent({ url: 'http://192.168.1.50:5179/', headers: { host: '172.20.5.10:5179' } })
	);
	expect(res.status).toBe(200);
});

test('Host akashs-mbp.local:5179 → passes (mDNS hostname)', async () => {
	const res = await runGate(
		makeEvent({ url: 'http://192.168.1.50:5179/', headers: { host: 'akashs-mbp.local:5179' } })
	);
	expect(res.status).toBe(200);
});

test('Host localhost:5179 → passes (loopback literal)', async () => {
	const res = await runGate(
		makeEvent({ url: 'http://127.0.0.1:5179/', headers: { host: 'localhost:5179' }, ip: '127.0.0.1' })
	);
	expect(res.status).toBe(200);
});

// --- X-Frame-Options on every response ---

test('200 response carries x-frame-options: DENY', async () => {
	const res = await runGate(makeEvent({ url: 'http://192.168.1.50:5179/' }));
	expect(res.headers.get('x-frame-options')).toBe('DENY');
});

test('403 response carries x-frame-options: DENY', async () => {
	const res = await runGate(makeEvent({ url: 'http://192.168.1.50:5179/api/focus', method: 'POST' }));
	expect(res.headers.get('x-frame-options')).toBe('DENY');
});

// --- SSE log redaction ---

test('SSE reject log line redacts ?t=', async () => {
	const originalWarn = console.warn;
	let captured = '';
	console.warn = (msg: string) => {
		captured = msg;
	};
	try {
		await runGate(makeEvent({ url: `http://192.168.1.50:5179/api/stream?t=${WRONG_TOKEN}` }));
	} finally {
		console.warn = originalWarn;
	}
	expect(captured).toContain('?t=<redacted>');
	expect(captured).not.toContain(WRONG_TOKEN);
});
