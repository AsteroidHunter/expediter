// AudioWorklet processor for the Baseten speech-to-prompt path. The AudioContext
// is created at 16 kHz (new AudioContext({ sampleRate: 16000 })), so the frames
// this receives are already mono 16 kHz — no resampling needed here; we only
// convert Float32 [-1,1] samples to signed 16-bit little-endian PCM (pcm_s16le,
// what the Baseten streaming endpoint expects) and post the raw bytes back to the
// main thread, which forwards them over the WebSocket.
//
// Lives in static/ (served as-is, no bundling) because audioWorklet.addModule()
// loads it by URL into the audio rendering thread, separate from the app bundle.
//
// NOTE: if a browser ignores the 16 kHz sampleRate request (older WebKit), the
// frames arrive at the hardware rate and would need resampling before this point —
// verify the context's actual sampleRate on a real device.
class PCMWorklet extends AudioWorkletProcessor {
	process(inputs) {
		const input = inputs[0];
		// No input yet (or the node was disconnected) — keep the processor alive.
		if (!input || input.length === 0 || !input[0]) return true;
		const channel = input[0]; // mono: we request a single input channel
		const pcm = new Int16Array(channel.length);
		for (let i = 0; i < channel.length; i++) {
			const s = Math.max(-1, Math.min(1, channel[i]));
			pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
		}
		// Transfer the buffer (zero-copy) to the main thread.
		this.port.postMessage(pcm.buffer, [pcm.buffer]);
		return true;
	}
}

registerProcessor('pcm-worklet', PCMWorklet);
