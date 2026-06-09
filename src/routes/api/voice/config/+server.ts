import { json, type RequestHandler } from '@sveltejs/kit';
import { getSttBackend } from '$lib/config';

// GET /api/voice/config → { backend: 'baseten' | 'voice' }. Lets the frontend pick
// which speech-to-prompt path the gesture drives (5.6). Token-gated by the global
// hooks.server.ts gate like every /api/* route. Deliberately returns ONLY the
// backend name — never the BASETEN_API_KEY or model id, which stay on the daemon.
export const GET: RequestHandler = async () => {
	return json({ backend: getSttBackend() });
};
