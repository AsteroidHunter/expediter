// Phone ↔ daemon audio WebSocket for the Baseten backend (speech-to-prompt). This
// attaches to the daemon's existing https.Server via its `upgrade` event in
// bin/expediter-server.mjs — NOT as a SvelteKit route: adapter-node's handler is
// request→response only and can't speak WS. Two consequences handled here:
//   - hooks.server.ts never runs on an upgrade, so the token gate is reimplemented
//     inline below (constant-time compare against getServerToken()).
//   - a browser WebSocket can't set the Authorization header, so the phone's token
//     and target pane travel in the connect query string (?token=…&pane=%N).
//
// Imports are RELATIVE, not `$lib/*`: this module is loaded directly by the raw Bun
// daemon entry (not through Vite), where the `$lib` alias does not resolve.
//
// `ws` is used only here, server-side (WebSocketServer noServer) — the verified-
// working path on Bun. The daemon→Baseten *client* uses Bun's native WebSocket
// (see basetenAdapter), avoiding the known ws-client-on-Bun breakage.
//
// NOT live-testable without a real BASETEN_API_KEY + deployed model + phone; the
// pure helpers (parseUpgradeRequest, the typing diff in basetenAdapter) are unit-
// tested, the socket relay is exercised by hand.

import { WebSocketServer, type WebSocket as WsWebSocket } from 'ws';
import { timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';
import type { Server } from 'node:http';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { getServerToken } from '../token';
import { getBasetenApiKey, getBasetenModelId } from '../config';
import { findByPane, setRecording } from '../ticketStore';
import { sendKeys, sendText, paneAcceptsInput } from '../tmux';
import {
	connectBaseten,
	computeTypingDiff,
	joinTranscript,
	type BasetenHandle
} from './basetenAdapter';

export const VOICE_WS_PATH = '/api/voice/stream';

// Control messages the daemon sends to the phone over the text channel.
type OutControl =
	| { type: 'ready' }
	| { type: 'partial'; text: string }
	| { type: 'final'; text: string }
	| { type: 'error'; message: string };

function constantTimeEqual(a: string, b: string): boolean {
	const aBuf = Buffer.from(a, 'utf8');
	const bBuf = Buffer.from(b, 'utf8');
	if (aBuf.length !== bBuf.length) return false;
	return timingSafeEqual(aBuf, bBuf);
}

function tokenOk(provided: string | null): boolean {
	if (!provided) return false;
	return constantTimeEqual(provided, getServerToken());
}

const isValidPane = (pane: string | null): pane is string => !!pane && /^%[0-9]+$/.test(pane);

// Parse the upgrade request URL into { path, token, pane }. Pure for unit-testing —
// the auth/validation gate keys off these. `req.url` is path+query only, so a dummy
// origin is supplied to URL().
export function parseUpgradeRequest(url: string): {
	path: string;
	token: string | null;
	pane: string | null;
} {
	let parsed: URL;
	try {
		parsed = new URL(url, 'http://localhost');
	} catch {
		return { path: '', token: null, pane: null };
	}
	return {
		path: parsed.pathname,
		token: parsed.searchParams.get('token'),
		pane: parsed.searchParams.get('pane')
	};
}

function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
	socket.write(`HTTP/1.1 ${status} ${reason}\r\n\r\n`);
	socket.destroy();
}

// Wire the phone↔daemon audio socket onto the daemon's https.Server. Call once,
// after the server is created and before/around listen().
export function attachVoiceSocket(server: Server): void {
	const wss = new WebSocketServer({ noServer: true });

	server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
		const { path, token, pane } = parseUpgradeRequest(req.url ?? '');
		// Only our path is a WebSocket; anything else gets the socket closed (the app
		// itself serves no other upgrades — the SSE stream is a plain HTTP response).
		if (path !== VOICE_WS_PATH) {
			socket.destroy();
			return;
		}
		if (!tokenOk(token)) return rejectUpgrade(socket, 401, 'Unauthorized');
		if (!isValidPane(pane)) return rejectUpgrade(socket, 400, 'Bad Request');

		// Gate on pane readiness + Baseten config BEFORE completing the handshake, so
		// rejections surface as HTTP upgrade failures and the relay setup below is
		// fully synchronous (no message-loss race during async checks).
		void (async () => {
			const readiness = await paneAcceptsInput(pane);
			if (!readiness.ready) return rejectUpgrade(socket, 409, 'Pane Not Ready');
			const apiKey = getBasetenApiKey();
			const modelId = getBasetenModelId();
			if (!apiKey || !modelId) return rejectUpgrade(socket, 503, 'Baseten Not Configured');
			wss.handleUpgrade(req, socket, head, (ws) => {
				handleConnection(ws as WsWebSocket, pane, apiKey, modelId);
			});
		})();
	});
}

function handleConnection(
	ws: WsWebSocket,
	pane: string,
	apiKey: string,
	modelId: string
): void {
	const session_id = findByPane(pane)?.session_id ?? null;
	if (session_id) setRecording(session_id, true);

	const safeSend = (msg: OutControl): void => {
		try {
			ws.send(JSON.stringify(msg));
		} catch {
			/* socket closing */
		}
	};

	// Accumulate transcripts across segments (OQ2): `finalized` is everything Baseten
	// has finalized so far; the live partial is shown appended to it. The pane (and
	// the phone mirror) always reflect finalized + current-partial.
	let finalized = '';

	// Serialize injections: each transcript revision waits for the prior one's
	// keystrokes so two fast partials can't interleave backspaces/typing on tmux.
	// `typed` tracks exactly what the daemon has put in the pane prompt.
	let typed = '';
	let chain: Promise<void> = Promise.resolve();
	const applyText = (next: string): void => {
		chain = chain.then(async () => {
			const { backspaces, append } = computeTypingDiff(typed, next);
			typed = next;
			try {
				if (backspaces > 0) await sendKeys(pane, new Array(backspaces).fill('BSpace'));
				if (append) await sendText(pane, append);
			} catch {
				/* pane vanished mid-typing; the close path clears state */
			}
		});
	};

	const baseten: BasetenHandle = connectBaseten(
		{ apiKey, modelId },
		{
			onPartial: (text) => {
				const display = joinTranscript(finalized, text);
				applyText(display);
				safeSend({ type: 'partial', text: display });
			},
			onFinal: (text) => {
				finalized = joinTranscript(finalized, text);
				applyText(finalized);
				safeSend({ type: 'final', text: finalized });
			},
			onError: (message) => {
				safeSend({ type: 'error', message });
				ws.close();
			},
			onClose: () => {
				/* Baseten side closed; the ws close handler does cleanup */
			}
		}
	);

	let finished = false;
	const finish = (clearInput: boolean): void => {
		if (finished) return;
		finished = true;
		baseten.close();
		if (session_id) setRecording(session_id, false);
		if (clearInput) void sendKeys(pane, ['C-u']).catch(() => {});
	};

	ws.on('message', (data: Buffer, isBinary: boolean) => {
		// Binary frames are PCM audio → relay straight to Baseten.
		if (isBinary) {
			baseten.sendAudio(data);
			return;
		}
		// Text frames are JSON control messages from the phone.
		let ctrl: { type?: string };
		try {
			ctrl = JSON.parse(data.toString('utf8')) as { type?: string };
		} catch {
			return;
		}
		if (ctrl.type === 'stop') {
			// User released — stop capturing, let Baseten flush the final transcript.
			baseten.endAudio();
		} else if (ctrl.type === 'send') {
			// Drain completed untouched — submit whatever is typed in the pane.
			void sendKeys(pane, ['Enter']).catch(() => {});
			finish(false);
			ws.close();
		} else if (ctrl.type === 'cancel') {
			// Discard — wipe the partial transcript from the prompt, submit nothing.
			finish(true);
			ws.close();
		}
	});
	ws.on('close', () => finish(false));
	ws.on('error', () => finish(false));

	safeSend({ type: 'ready' });
}
