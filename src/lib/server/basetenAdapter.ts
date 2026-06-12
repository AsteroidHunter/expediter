// Provider-specific adapter for Baseten's streaming-transcription WebSocket — the
// ONLY piece tied to a particular STT provider (the architecture's "STT model is
// swappable" seam). Everything else (16 kHz mono PCM, the daemon proxy, the
// gesture, live-typing, the recording flag) is provider-agnostic. Swapping the
// provider/model rewrites this file's URL / auth / metadata / parse and nothing
// else; `baseten_model_id` selects which deployment the URL targets.
//
// Protocol (Baseten streaming transcription API — documented for its Whisper
// deployment but generic to the streaming endpoint):
//   - URL:   wss://model-<id>.api.baseten.co/environments/production/websocket
//   - Auth:  Authorization: Api-Key <key>   (a server-side client; a browser
//            WebSocket can't set this header — hence the daemon proxies audio)
//   - Send a metadata JSON string first, then raw PCM s16le binary frames.
//   - Signal end of audio with {"type":"end_audio"}.
//   - Receive {"type":"transcription","is_final":bool,"segments":[{"text":…}]}.
//
// NOT live-testable without a real BASETEN_API_KEY + deployed model; the wire
// shape below is from the docs and must be re-confirmed against the chosen model.

export function buildBasetenUrl(modelId: string): string {
	return `wss://model-${modelId}.api.baseten.co/environments/production/websocket`;
}

// The metadata frame sent first (as a JSON string). Only streaming_params (the
// audio format) is universal across streaming-STT models; model-specific tuning
// (whisper_params, VAD) is intentionally omitted to keep this model-agnostic — add
// it here if a chosen deployment requires it.
export function buildBasetenMetadata(): string {
	return JSON.stringify({
		streaming_params: {
			encoding: 'pcm_s16le',
			sample_rate: 16000,
			enable_partial_transcripts: true
		}
	});
}

export type BasetenMessage =
	| { kind: 'partial'; text: string }
	| { kind: 'final'; text: string }
	| { kind: 'end' }
	| { kind: 'other' };

// Parse one text frame from Baseten into a transcript event. A transcription
// message carries segments[].text (joined) and an is_final flag; the end_audio ack
// is 'end'; anything else (status acks, unknown types, non-JSON) is 'other'. Pure
// for unit-testing — this is the line most likely to need tweaking for a different
// deployed model.
export function parseBasetenMessage(raw: string): BasetenMessage {
	let msg: unknown;
	try {
		msg = JSON.parse(raw);
	} catch {
		return { kind: 'other' };
	}
	if (!msg || typeof msg !== 'object') return { kind: 'other' };
	const m = msg as Record<string, unknown>;
	if (m.type === 'end_audio') return { kind: 'end' };
	if (m.type === 'transcription') {
		const segments = Array.isArray(m.segments) ? m.segments : [];
		const text = segments
			.map((s) =>
				s && typeof s === 'object' ? String((s as Record<string, unknown>).text ?? '') : ''
			)
			.join('')
			.trim();
		return m.is_final === true ? { kind: 'final', text } : { kind: 'partial', text };
	}
	return { kind: 'other' };
}

// Incremental live-typing diff: given the text already typed into the pane and the
// next revision, return how many characters to erase (backspaces) and the suffix to
// append, by keeping the common prefix. Streaming STT revises text in-flight, so
// this keeps the per-revision keystroke churn (and the flicker of not owning Claude
// Code's input) minimal. Pure.
//
// Counts in Unicode CODE POINTS, not UTF-16 units: a BSpace erases at least one
// code point, never half a surrogate pair — counting units sent one BSpace per
// unit, so revising away an astral char (emoji) erased it AND its neighbor, then
// appended over the mangled line. Residual ambiguity: whether Claude Code's input
// deletes a full grapheme CLUSTER (e.g. e + combining accent, ZWJ emoji) per
// backspace is unverified — STT output is normalized (NFC) in practice, so code
// points match user-perceived characters for realistic transcripts; confirm
// cluster behavior in the live CC probe before relying on it.
export function computeTypingDiff(
	prev: string,
	next: string
): { backspaces: number; append: string } {
	if (prev === next) return { backspaces: 0, append: '' };
	const a = Array.from(prev);
	const b = Array.from(next);
	let i = 0;
	const min = Math.min(a.length, b.length);
	while (i < min && a[i] === b[i]) i++;
	return { backspaces: a.length - i, append: b.slice(i).join('') };
}

// Accumulate streaming segments: join the latest (partial or final) text onto the
// already-finalized text with a single separating space. Baseten emits transcripts
// per speech segment (Open Question 2's working assumption), so the daemon
// concatenates them across the recording. IF a chosen deployment instead sends the
// full cumulative transcript in every message, this join is wrong — replace the
// call site with a pass-through of `latest`. Pure.
export function joinTranscript(finalized: string, latest: string): string {
	const a = finalized.trim();
	const b = latest.trim();
	if (!a) return b;
	if (!b) return a;
	return `${a} ${b}`;
}

export type BasetenHandle = {
	sendAudio: (pcm: ArrayBufferView | ArrayBuffer) => void;
	endAudio: () => void;
	close: () => void;
};

export type BasetenCallbacks = {
	onPartial: (text: string) => void;
	onFinal: (text: string) => void;
	onError: (message: string) => void;
	onClose: () => void;
};

// Bun's WebSocket accepts a { headers } options bag the DOM lib's type omits; cast
// the constructor once to a Bun-aware signature. This module runs only in the Bun
// daemon, so Bun's header-capable WebSocket is guaranteed at runtime — the cast is
// purely to satisfy TypeScript's DOM-shaped global.
type WsWithHeaders = { new (url: string, options?: { headers?: Record<string, string> }): WebSocket };

// How many PCM frames to buffer before the Baseten socket finishes opening, so the
// start of speech isn't clipped. Bounded so a socket that never opens can't grow it
// without limit; frames past the cap are dropped.
const MAX_PENDING_FRAMES = 512;

// Open a Baseten streaming-STT socket and relay transcripts through the callbacks.
// Returns a handle for streaming PCM, signaling end, and closing. The returned
// handle is usable immediately: PCM sent before the socket opens is buffered (up to
// MAX_PENDING_FRAMES) and flushed after the metadata frame.
export function connectBaseten(
	opts: { apiKey: string; modelId: string },
	cb: BasetenCallbacks
): BasetenHandle {
	const WS = WebSocket as unknown as WsWithHeaders;
	const socket = new WS(buildBasetenUrl(opts.modelId), {
		headers: { Authorization: `Api-Key ${opts.apiKey}` }
	});
	socket.binaryType = 'arraybuffer';

	let open = false;
	const pending: Array<ArrayBufferView | ArrayBuffer> = [];

	socket.addEventListener('open', () => {
		socket.send(buildBasetenMetadata());
		open = true;
		for (const buf of pending) socket.send(buf as ArrayBuffer);
		pending.length = 0;
	});
	socket.addEventListener('message', (ev: MessageEvent) => {
		// Transcripts arrive as text frames; binary frames (if any) are not expected.
		if (typeof ev.data !== 'string') return;
		const parsed = parseBasetenMessage(ev.data);
		if (parsed.kind === 'partial') cb.onPartial(parsed.text);
		else if (parsed.kind === 'final') cb.onFinal(parsed.text);
	});
	socket.addEventListener('error', () => cb.onError('Baseten connection error'));
	socket.addEventListener('close', () => cb.onClose());

	return {
		sendAudio: (pcm) => {
			if (open && socket.readyState === WebSocket.OPEN) {
				socket.send(pcm as ArrayBuffer);
			} else if (pending.length < MAX_PENDING_FRAMES) {
				pending.push(pcm);
			}
		},
		endAudio: () => {
			if (socket.readyState === WebSocket.OPEN) {
				socket.send(JSON.stringify({ type: 'end_audio' }));
			}
		},
		close: () => {
			try {
				socket.close();
			} catch {
				/* already closing/closed */
			}
		}
	};
}
