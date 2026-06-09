import { json, type RequestHandler } from '@sveltejs/kit';
import { getSttBackend, setSttBackend } from '$lib/config';

// GET /api/voice/config → { backend: 'baseten' | 'voice' }. Lets the frontend pick
// which speech-to-prompt path the gesture drives (5.6). Token-gated by the global
// hooks.server.ts gate like every /api/* route. Deliberately returns ONLY the
// backend name — never the BASETEN_API_KEY or model id, which stay on the daemon.
export const GET: RequestHandler = async () => {
	return json({ backend: getSttBackend() });
};

// POST /api/voice/config { backend } — persist the backend choice from the settings
// UI (6.1). Merges into config.json so other settings survive. Token-gated.
export const POST: RequestHandler = async ({ request }) => {
	let body: { backend?: unknown };
	try {
		body = (await request.json()) as { backend?: unknown };
	} catch {
		return json({ ok: false, error: 'invalid json' }, { status: 400 });
	}
	const backend = body.backend;
	if (backend !== 'baseten' && backend !== 'voice') {
		return json({ ok: false, error: 'invalid backend' }, { status: 400 });
	}
	try {
		setSttBackend(backend);
	} catch {
		return json({ ok: false, error: 'could not write config' }, { status: 500 });
	}
	return json({ ok: true, backend });
};
