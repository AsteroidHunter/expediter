import { json, type RequestHandler } from '@sveltejs/kit';
import { detachSession, FocusError } from '$lib/tmux';

// Detach-from-phone: the swipe-and-hold gesture on an Attached card POSTs here.
// Token-gated by the gate (phone-initiated, like /api/focus and /api/attach).
// Mirrors their response shape: 400 on bad body, 410 when the pane/session is
// gone (FocusError), 500 otherwise. The next reconcile (fired by the tmux
// client-detached hook) moves the card to the Detached page.
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
		await detachSession(pane);
		return json({ ok: true });
	} catch (err) {
		if (err instanceof FocusError) {
			console.log(`[detach] FocusError pane=${pane} err=${err.message}`);
			return json({ ok: false, error: err.message }, { status: 410 });
		}
		const msg = err instanceof Error ? err.message : 'detach failed';
		console.log(`[detach] error pane=${pane} err=${msg}`);
		return json({ ok: false, error: msg }, { status: 500 });
	}
};
