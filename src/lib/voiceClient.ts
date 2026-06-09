// Browser-side recording controller for speech-to-prompt (Phase 5). Hides the two
// backends behind one VoiceSession interface so the gesture FSM in +page.svelte is
// backend-agnostic (5.6):
//
//   - 'voice'   — built-in Claude Code /voice (laptop mic does the transcription).
//                 The phone only POSTs start/stop/cancel; it never opens the phone
//                 mic, since the user speaks at the laptop and the phone has no useful
//                 signal. The dock shows a recording-status pulse, not a waveform.
//   - 'baseten' — phone mic. getUserMedia → AudioContext(16 kHz) → pcm-worklet →
//                 PCM frames over a WebSocket to the daemon, which proxies Baseten
//                 and types the transcript into the pane; onPartial/onFinal mirror the
//                 live transcript. (onAmplitude is still emitted but currently unused
//                 — the UI is a status pulse for both backends.)
//
// $lib import is fine here — this module is bundled into the client by Vite (it's
// imported by +page.svelte), unlike the daemon-only voiceSocket.ts.
//
// NOT verifiable without a real touch device + mic + HTTPS (and, for Baseten, a
// deployed model). The gesture→action mapping and Web Audio plumbing are written to
// be correct-by-construction; on-device iteration is expected.

export type VoiceBackend = 'baseten' | 'voice';

export interface VoiceHandlers {
	onPartial?(text: string): void;
	onFinal?(text: string): void;
	onAmplitude?(level: number): void; // 0..1, Baseten only (mic loudness)
	onError?(message: string): void;
}

export interface VoiceSession {
	release(): void; // pointerup from RECORDING → pause capture, enter the drain
	resume(): void; // tap-and-hold during the drain → resume capture
	send(): void; // drain completed untouched → finalize + submit
	cancel(): void; // cancel button → discard, submit nothing
	dispose(): void; // hard teardown (error / unmount)
}

async function postVoice(path: string, pane: string, token: string): Promise<void> {
	await fetch(path, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'x-expediter-token': token },
		body: JSON.stringify({ pane })
	});
}

// Built-in /voice: the laptop mic does the transcription; the phone only POSTs
// start/stop/cancel. It does NOT open the phone mic — the user speaks at the laptop,
// so the phone has no useful signal to meter. The indicator is a status pulse, not a
// waveform. release/resume are no-ops (the daemon's /voice keeps recording until
// send/cancel).
function startVoiceBackend(pane: string, token: string, handlers: VoiceHandlers): VoiceSession {
	void postVoice('/api/voice/start', pane, token).catch(() =>
		handlers.onError?.('Could not start /voice')
	);
	let done = false;
	const finish = (path: string): void => {
		if (done) return;
		done = true;
		void postVoice(path, pane, token).catch(() => {});
	};
	return {
		release() {
			/* recording continues on the laptop until send/cancel */
		},
		resume() {
			/* still recording */
		},
		send() {
			finish('/api/voice/stop');
		},
		cancel() {
			finish('/api/voice/cancel');
		},
		dispose() {
			finish('/api/voice/cancel');
		}
	};
}

// Baseten: capture phone-mic PCM and stream it to the daemon over a WebSocket.
async function startBasetenBackend(
	pane: string,
	token: string,
	handlers: VoiceHandlers
): Promise<VoiceSession> {
	// Secure-context APIs — getUserMedia needs HTTPS (the whole reason the HTTPS work
	// shipped). Request mono; the AudioContext is pinned to 16 kHz so the worklet
	// emits 16 kHz PCM directly (no resampling).
	const stream = await navigator.mediaDevices.getUserMedia({
		audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }
	});
	const ctx = new AudioContext({ sampleRate: 16000 });
	await ctx.audioWorklet.addModule('/pcm-worklet.js');

	const source = ctx.createMediaStreamSource(stream);
	const worklet = new AudioWorkletNode(ctx, 'pcm-worklet');
	const analyser = ctx.createAnalyser();
	analyser.fftSize = 512;
	source.connect(analyser);
	source.connect(worklet);
	// The worklet must run, but we don't want its (silent) output in the speakers,
	// so route it to a zero-gain sink rather than ctx.destination.
	const sink = ctx.createGain();
	sink.gain.value = 0;
	worklet.connect(sink).connect(ctx.destination);

	const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/voice/stream?token=${encodeURIComponent(token)}&pane=${encodeURIComponent(pane)}`;
	const ws = new WebSocket(wsUrl);
	ws.binaryType = 'arraybuffer';

	let paused = false;
	let disposed = false;
	let pendingSend = false; // send() called; waiting for 'final' before Enter

	worklet.port.onmessage = (ev: MessageEvent) => {
		if (paused || disposed) return;
		if (ws.readyState === WebSocket.OPEN) ws.send(ev.data as ArrayBuffer);
	};

	ws.addEventListener('message', (ev: MessageEvent) => {
		if (typeof ev.data !== 'string') return;
		let msg: { type?: string; text?: string; message?: string };
		try {
			msg = JSON.parse(ev.data);
		} catch {
			return;
		}
		if (msg.type === 'partial') handlers.onPartial?.(msg.text ?? '');
		else if (msg.type === 'final') {
			handlers.onFinal?.(msg.text ?? '');
			// send() was waiting for the finalized transcript before submitting.
			if (pendingSend) {
				pendingSend = false;
				submitAndClose();
			}
		} else if (msg.type === 'error') {
			handlers.onError?.(msg.message ?? 'voice error');
			dispose();
		}
	});
	ws.addEventListener('error', () => handlers.onError?.('audio connection error'));
	ws.addEventListener('close', () => {
		if (!disposed) dispose();
	});

	// RMS amplitude meter for the real waveform. Runs while not paused/disposed.
	const timeData = new Float32Array(analyser.fftSize);
	let raf = 0;
	const meter = () => {
		if (disposed) return;
		if (!paused) {
			analyser.getFloatTimeDomainData(timeData);
			let sum = 0;
			for (let i = 0; i < timeData.length; i++) sum += timeData[i] * timeData[i];
			const rms = Math.sqrt(sum / timeData.length);
			// Gate the noise floor so silence reads flat instead of bouncing on ambient
			// hiss, then scale so speech fills the meter; clamp to 0..1.
			const NOISE_FLOOR = 0.02;
			const level = rms <= NOISE_FLOOR ? 0 : Math.min(1, (rms - NOISE_FLOOR) * 6);
			handlers.onAmplitude?.(level);
		}
		raf = requestAnimationFrame(meter);
	};
	raf = requestAnimationFrame(meter);

	function sendCtrl(type: string): void {
		if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type }));
	}

	function submitAndClose(): void {
		sendCtrl('send'); // daemon presses Enter
		dispose();
	}

	function dispose(): void {
		if (disposed) return;
		disposed = true;
		if (raf) cancelAnimationFrame(raf);
		try {
			worklet.port.onmessage = null;
			source.disconnect();
			worklet.disconnect();
		} catch {
			/* nodes already torn down */
		}
		for (const track of stream.getTracks()) track.stop();
		void ctx.close().catch(() => {});
		try {
			ws.close();
		} catch {
			/* already closing */
		}
	}

	return {
		release() {
			// Pause sending audio but keep the WS + mic open so a resume can continue
			// the same recording. Do NOT finalize yet (that happens on send()).
			paused = true;
			handlers.onAmplitude?.(0);
		},
		resume() {
			paused = false;
		},
		send() {
			// Finalize: ask the daemon to end the audio stream, then submit once the
			// final transcript has been typed (or after a short fallback timeout, so a
			// missing 'final' can't strand the gesture).
			if (disposed) return;
			pendingSend = true;
			sendCtrl('stop');
			setTimeout(() => {
				if (pendingSend && !disposed) {
					pendingSend = false;
					submitAndClose();
				}
			}, 1500);
		},
		cancel() {
			sendCtrl('cancel'); // daemon clears the pane input
			dispose();
		},
		dispose
	};
}

export async function startVoiceSession(
	opts: { backend: VoiceBackend; pane: string; token: string },
	handlers: VoiceHandlers
): Promise<VoiceSession> {
	if (opts.backend === 'baseten') {
		return startBasetenBackend(opts.pane, opts.token, handlers);
	}
	return startVoiceBackend(opts.pane, opts.token, handlers);
}
