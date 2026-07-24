import { json, type RequestHandler } from '@sveltejs/kit';
import { postResult } from '$lib/server/remoteTap';

// Tap-outcome delivery from a devbox helper (D16): after the helper runs the
// window flip it POSTs what happened, and the focus request that dispatched
// the tap is unblocked with it. Loopback-trusted like the poll route — see
// its header. A late result (the dispatch already timed out) answers
// matched:false and is otherwise ignored.

const MAX_NAME_LEN = 256;

export const POST: RequestHandler = async ({ request }) => {
	let body: {
		tap_id?: unknown;
		ok?: unknown;
		session_attached?: unknown;
		session_name?: unknown;
		error?: unknown;
	};
	try {
		body = (await request.json()) as typeof body;
	} catch {
		return json({ ok: false, error: 'invalid json' }, { status: 400 });
	}

	if (typeof body.tap_id !== 'string' || !body.tap_id) {
		return json({ ok: false, error: 'missing tap_id' }, { status: 400 });
	}

	const matched = postResult(body.tap_id, {
		ok: body.ok === true,
		...(typeof body.session_attached === 'boolean'
			? { session_attached: body.session_attached }
			: {}),
		...(typeof body.session_name === 'string' && body.session_name.length <= MAX_NAME_LEN
			? { session_name: body.session_name }
			: {}),
		...(typeof body.error === 'string' ? { error: body.error.slice(0, 512) } : {})
	});

	return json({ ok: true, matched });
};
