import { test, expect, beforeEach, afterEach } from 'bun:test';
import { startVoiceSession, type VoiceHandlers } from './voiceClient';

// Contract tests for the two VoiceSession backends, with the browser globals
// faked. These pin the failure-handling behavior the on-device bugs traced to:
// a refused start must surface AND latch (no follow-up injection), stop/cancel
// must serialize behind the start POST, and an unexpected WS close must notify
// the FSM (onClosed) instead of leaving a zombie session that fakes a "sent".

// ─── shared fixtures ─────────────────────────────────────────────────────────

type FetchCall = { path: string; pane: string; token: string | undefined };

let fetchCalls: FetchCall[];
let originalFetch: typeof fetch;
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 1));

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' }
	});
}

// Install a fetch fake. `respond` maps a path to its Response (or a promise of
// one, for ordering tests); every call is recorded in fetchCalls.
function fakeFetch(respond: (path: string) => Response | Promise<Response>): void {
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const path = String(input);
		const body = init?.body ? (JSON.parse(String(init.body)) as { pane?: string }) : {};
		const headers = (init?.headers ?? {}) as Record<string, string>;
		fetchCalls.push({ path, pane: body.pane ?? '', token: headers['x-expediter-token'] });
		return respond(path);
	}) as typeof fetch;
}

beforeEach(() => {
	fetchCalls = [];
	originalFetch = globalThis.fetch;
});
afterEach(() => {
	globalThis.fetch = originalFetch;
});

// ─── /voice backend ──────────────────────────────────────────────────────────

const VOICE_OPTS = { backend: 'voice' as const, pane: '%42', token: 'tok-1' };

test('voice: send() POSTs stop with the pane and token after a successful start', async () => {
	fakeFetch(() => jsonResponse(200, { ok: true }));
	const session = await startVoiceSession(VOICE_OPTS, {});
	await flush(); // let the start POST settle
	session.send();
	await flush();
	expect(fetchCalls.map((c) => c.path)).toEqual(['/api/voice/start', '/api/voice/stop']);
	expect(fetchCalls[1]).toEqual({ path: '/api/voice/stop', pane: '%42', token: 'tok-1' });
});

test('voice: a refused start surfaces the daemon error and latches the session dead', async () => {
	fakeFetch((path) =>
		path === '/api/voice/start'
			? jsonResponse(409, { ok: false, error: "pane is running 'vim', not Claude Code" })
			: jsonResponse(200, { ok: true })
	);
	const errors: string[] = [];
	const handlers: VoiceHandlers = { onError: (m) => errors.push(m) };
	const session = await startVoiceSession(VOICE_OPTS, handlers);
	await flush();
	expect(errors).toEqual(["pane is running 'vim', not Claude Code"]);
	// The dictation never started: ✓/✗/teardown must NOT inject anything — a
	// stray stop-Space on an idle pane STARTS a dictation (the inversion bug).
	session.send();
	session.cancel();
	session.dispose();
	await flush();
	expect(fetchCalls.map((c) => c.path)).toEqual(['/api/voice/start']);
});

test('voice: finish is once-only — cancel after send does not fire a second POST', async () => {
	fakeFetch(() => jsonResponse(200, { ok: true }));
	const session = await startVoiceSession(VOICE_OPTS, {});
	await flush();
	session.send();
	session.cancel();
	session.dispose();
	await flush();
	expect(fetchCalls.map((c) => c.path)).toEqual(['/api/voice/start', '/api/voice/stop']);
});

test('voice: a ✓ that beats the start response is serialized behind it', async () => {
	let resolveStart!: (r: Response) => void;
	fakeFetch((path) =>
		path === '/api/voice/start'
			? new Promise<Response>((r) => {
					resolveStart = r;
				})
			: jsonResponse(200, { ok: true })
	);
	const session = await startVoiceSession(VOICE_OPTS, {});
	session.send(); // user is faster than the daemon
	await flush();
	// stop must NOT have been issued yet — on the wire it would overtake start.
	expect(fetchCalls.map((c) => c.path)).toEqual(['/api/voice/start']);
	resolveStart(jsonResponse(200, { ok: true }));
	await flush();
	expect(fetchCalls.map((c) => c.path)).toEqual(['/api/voice/start', '/api/voice/stop']);
});

test('voice: a failed stop is reported, not swallowed', async () => {
	fakeFetch((path) =>
		path === '/api/voice/stop'
			? jsonResponse(409, { ok: false, error: 'no active /voice recording for this pane' })
			: jsonResponse(200, { ok: true })
	);
	const errors: string[] = [];
	const session = await startVoiceSession(VOICE_OPTS, { onError: (m) => errors.push(m) });
	await flush();
	session.send();
	await flush();
	expect(errors).toEqual(['no active /voice recording for this pane']);
});

// ─── Baseten backend (Web Audio + WS faked) ──────────────────────────────────

class FakeWebSocket {
	static CONNECTING = 0;
	static OPEN = 1;
	static CLOSING = 2;
	static CLOSED = 3;
	static instances: FakeWebSocket[] = [];
	url: string;
	binaryType = '';
	readyState = FakeWebSocket.OPEN;
	sent: unknown[] = [];
	private listeners = new Map<string, Set<(ev: unknown) => void>>();
	constructor(url: string) {
		this.url = url;
		FakeWebSocket.instances.push(this);
	}
	addEventListener(type: string, fn: (ev: unknown) => void): void {
		if (!this.listeners.has(type)) this.listeners.set(type, new Set());
		this.listeners.get(type)!.add(fn);
	}
	send(data: unknown): void {
		this.sent.push(data);
	}
	close(): void {
		if (this.readyState === FakeWebSocket.CLOSED) return;
		this.readyState = FakeWebSocket.CLOSED;
		this.fire('close', {});
	}
	fire(type: string, ev: unknown): void {
		for (const fn of [...(this.listeners.get(type) ?? [])]) fn(ev);
	}
	ctrlFrames(): string[] {
		return this.sent
			.filter((d): d is string => typeof d === 'string')
			.map((d) => (JSON.parse(d) as { type: string }).type);
	}
}

class FakeAudioNode {
	connect(next: unknown): unknown {
		return next;
	}
	disconnect(): void {}
}

class FakeAudioWorkletNode extends FakeAudioNode {
	port: { onmessage: ((ev: unknown) => void) | null } = { onmessage: null };
	constructor(_ctx: unknown, _name: string) {
		super();
	}
}

class FakeAudioContext {
	state = 'running';
	destination = {};
	audioWorklet = { addModule: async (_url: string) => {} };
	constructor(_opts?: unknown) {}
	createMediaStreamSource(_stream: unknown): FakeAudioNode {
		return new FakeAudioNode();
	}
	createAnalyser(): { fftSize: number; getFloatTimeDomainData: (a: Float32Array) => void; connect: () => void } {
		return { fftSize: 512, getFloatTimeDomainData: () => {}, connect: () => {} };
	}
	createGain(): { gain: { value: number }; connect: (next: unknown) => unknown } {
		return { gain: { value: 0 }, connect: (next: unknown) => next };
	}
	close(): Promise<void> {
		return Promise.resolve();
	}
	resume(): Promise<void> {
		return Promise.resolve();
	}
}

type GlobalPatch = { key: string; had: boolean; value: unknown };
let patches: GlobalPatch[] = [];

function patchGlobal(key: string, value: unknown): void {
	const g = globalThis as unknown as Record<string, unknown>;
	patches.push({ key, had: key in g, value: g[key] });
	g[key] = value;
}

function installBasetenFakes(): { stoppedTracks: () => number } {
	let stopped = 0;
	FakeWebSocket.instances = [];
	patchGlobal('WebSocket', FakeWebSocket);
	patchGlobal('AudioContext', FakeAudioContext);
	patchGlobal('AudioWorkletNode', FakeAudioWorkletNode);
	patchGlobal('location', { protocol: 'https:', host: 'phone.test' });
	patchGlobal('requestAnimationFrame', () => 0);
	patchGlobal('cancelAnimationFrame', () => {});
	patchGlobal('navigator', {
		mediaDevices: {
			getUserMedia: async () => ({
				getTracks: () => [
					{
						stop: () => {
							stopped++;
						}
					}
				]
			})
		}
	});
	return { stoppedTracks: () => stopped };
}

afterEach(() => {
	const g = globalThis as unknown as Record<string, unknown>;
	for (const p of patches.reverse()) {
		if (p.had) g[p.key] = p.value;
		else delete g[p.key];
	}
	patches = [];
});

const BASETEN_OPTS = { backend: 'baseten' as const, pane: '%42', token: 'tok-1' };

test('baseten: an unexpected WS close disposes and fires onClosed exactly once', async () => {
	const mics = installBasetenFakes();
	let closed = 0;
	const session = await startVoiceSession(BASETEN_OPTS, { onClosed: () => closed++ });
	const ws = FakeWebSocket.instances[0];
	// Server-side close (daemon restart / network change), not user-initiated:
	ws.readyState = FakeWebSocket.CLOSED;
	ws.fire('close', {});
	expect(closed).toBe(1);
	expect(mics.stoppedTracks()).toBe(1);
	// The zombie ✓: send() on the dead session must not emit anything.
	session.send();
	expect(ws.ctrlFrames()).toEqual([]);
});

test('baseten: cancel() sends the cancel control frame and does NOT fire onClosed', async () => {
	installBasetenFakes();
	let closed = 0;
	const session = await startVoiceSession(BASETEN_OPTS, { onClosed: () => closed++ });
	const ws = FakeWebSocket.instances[0];
	session.cancel();
	expect(ws.ctrlFrames()).toEqual(['cancel']);
	expect(closed).toBe(0); // intentional teardown is not a connection loss
});

test('baseten: send() stops the stream, then submits once the final transcript lands', async () => {
	installBasetenFakes();
	let closed = 0;
	const finals: string[] = [];
	const session = await startVoiceSession(BASETEN_OPTS, {
		onClosed: () => closed++,
		onFinal: (t) => finals.push(t)
	});
	const ws = FakeWebSocket.instances[0];
	session.send();
	expect(ws.ctrlFrames()).toEqual(['stop']); // waiting on the final transcript
	ws.fire('message', { data: JSON.stringify({ type: 'final', text: 'hello world' }) });
	expect(finals).toEqual(['hello world']);
	expect(ws.ctrlFrames()).toEqual(['stop', 'send']);
	expect(closed).toBe(0);
});
