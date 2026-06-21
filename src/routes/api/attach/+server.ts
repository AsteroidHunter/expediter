import { json, type RequestHandler } from '@sveltejs/kit';
import { attachSession, FocusError } from '$lib/tmux';

// Tap-to-attach for the Detached page: re-attaches a detached session by opening
// a fresh Terminal window running `tmux attach -t <session>`. Token-gated by the
// gate (not loopback-bypassed — this is phone-initiated, like /api/focus).
// Mirrors /api/focus's response shape: 400 on bad body, 410 when the pane/
// session is gone (FocusError), 500 otherwise.
export const POST: RequestHandler = async ({ request }) => {
	let body: { pane?: string };
	try {
		body = (await request.json()) as { pane?: string };
	} catch {
		return json({ ok: false, error: 'invalid json' }, { status: 400 });
	}

	const pane = body.pane;
	if (!pane) {
		return json({ ok: false, error: 'missing pane' }, { status: 400 });
	}

	try {
		await attachSession(pane);
		return json({ ok: true });
	} catch (err) {
		if (err instanceof FocusError) {
			console.log(`[attach] FocusError pane=${pane} err=${err.message}`);
			return json({ ok: false, error: err.message }, { status: 410 });
		}
		const msg = err instanceof Error ? err.message : 'attach failed';
		console.log(`[attach] error pane=${pane} err=${msg}`);
		return json({ ok: false, error: msg }, { status: 500 });
	}
};
