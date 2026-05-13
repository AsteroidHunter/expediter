import { json, type RequestHandler } from '@sveltejs/kit';
import { focusPane, FocusError } from '$lib/tmux';

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
		await focusPane(pane);
		return json({ ok: true });
	} catch (err) {
		if (err instanceof FocusError) {
			return json({ ok: false, error: err.message }, { status: 410 });
		}
		const msg = err instanceof Error ? err.message : 'focus failed';
		return json({ ok: false, error: msg }, { status: 500 });
	}
};
