import { json } from '@sveltejs/kit';
import { randomBytes } from 'node:crypto';
import { AccessToken } from 'livekit-server-sdk';
import type { RequestHandler } from './$types';

// Mints a short-lived LiveKit access token so the phone can join the orchestrator
// voice room — the oppie worker is the other participant. This sits under /api/,
// so the global token gate in hooks.server.ts already requires a valid expediter
// token before this handler runs; no LiveKit creds are ever handed to an
// unauthenticated caller. Returns 503 when the daemon was launched without the
// LiveKit env, so the client can show "voice not configured" instead of hanging.
const ROOM = (process.env.OPPIE_ROOM ?? 'oppie-orchestrator').trim();

export const GET: RequestHandler = async () => {
	const url = process.env.LIVEKIT_URL;
	const key = process.env.LIVEKIT_API_KEY;
	const secret = process.env.LIVEKIT_API_SECRET;
	if (!url || !key || !secret) {
		return json(
			{ ok: false, error: 'LiveKit is not configured on the daemon.' },
			{ status: 503 }
		);
	}

	const identity = `expediter-phone-${randomBytes(4).toString('hex')}`;
	const at = new AccessToken(key, secret, { identity, ttl: '1h' });
	at.addGrant({
		roomJoin: true,
		room: ROOM,
		canPublish: true,
		canSubscribe: true,
		canPublishData: true
	});
	const token = await at.toJwt();

	return json({ ok: true, room: ROOM, url, token, identity });
};
