// Browser-only LiveKit controller for the "Talk to orchestrator" button. Joins
// the oppie voice room, publishes the phone mic, and plays back the agent's
// audio. Never import this from a server file or at a component's top level —
// load it with a dynamic import() from a click handler so `livekit-client`
// stays out of SSR and off the entry bundle. Requires a secure context
// (https or localhost) for the mic; on plain http over a LAN IP the browser
// blocks getUserMedia and connect() rejects with the friendly mic message.

import { Room, RoomEvent, Track, type RemoteTrack } from 'livekit-client';

export type VoiceState = 'connecting' | 'live' | 'error';

export interface VoiceController {
	hangUp: () => Promise<void>;
}

interface StartOpts {
	clientToken: string;
	onState: (state: VoiceState, detail?: string) => void;
}

export async function startVoice({ clientToken, onState }: StartOpts): Promise<VoiceController> {
	onState('connecting');

	// 1. Mint a room token. Gated by the expediter token, exactly like every
	//    other /api call the phone makes.
	let res: Response;
	try {
		res = await fetch('/api/livekit-token', {
			headers: { 'x-expediter-token': clientToken }
		});
	} catch {
		onState('error', 'Network error reaching the daemon.');
		throw new Error('token-fetch-failed');
	}
	if (!res.ok) {
		const msg =
			res.status === 503
				? 'Voice is not configured on the daemon.'
				: 'Could not get a voice token.';
		onState('error', msg);
		throw new Error(`token-${res.status}`);
	}
	const { url, token } = (await res.json()) as { url: string; token: string };

	// 2. Connect, publish the mic, and wire up playback.
	const room = new Room({ adaptiveStream: true, dynacast: true });
	const audioEls = new Set<HTMLAudioElement>();
	let closing = false;

	function playAudioTrack(track: RemoteTrack): void {
		if (track.kind !== Track.Kind.Audio) return;
		const el = track.attach() as HTMLAudioElement;
		el.autoplay = true;
		(el as HTMLAudioElement & { playsInline?: boolean }).playsInline = true;
		el.style.display = 'none';
		document.body.appendChild(el);
		audioEls.add(el);
	}

	room.on(RoomEvent.TrackSubscribed, (track) => playAudioTrack(track as RemoteTrack));
	room.on(RoomEvent.Disconnected, () => {
		// Only surface as an error when the server/network dropped us, not when the
		// user tapped hang up (which also fires Disconnected).
		if (!closing) onState('error', 'Disconnected.');
	});

	try {
		await room.connect(url, token);
		// Attach any audio tracks already present (the agent may have joined first).
		for (const p of room.remoteParticipants.values()) {
			for (const pub of p.trackPublications.values()) {
				if (pub.track) playAudioTrack(pub.track as RemoteTrack);
			}
		}
		await room.localParticipant.setMicrophoneEnabled(true);
		// iOS autoplay unlock — must run inside the user gesture that started this.
		await room.startAudio().catch(() => {});
	} catch (e) {
		onState('error', 'Microphone or connection was blocked.');
		try {
			await room.disconnect();
		} catch {
			/* already down */
		}
		throw e instanceof Error ? e : new Error('connect-failed');
	}

	onState('live');

	return {
		hangUp: async () => {
			closing = true;
			try {
				await room.localParticipant.setMicrophoneEnabled(false);
			} catch {
				/* ignore */
			}
			try {
				await room.disconnect();
			} catch {
				/* ignore */
			}
			for (const el of audioEls) el.remove();
			audioEls.clear();
		}
	};
}
