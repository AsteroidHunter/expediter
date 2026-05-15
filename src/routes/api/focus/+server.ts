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

	const t0 = Date.now();
	console.log(`[focus] req pane=${pane}`);
	try {
		await focusPane(pane);
		const dt = Date.now() - t0;
		console.log(`[focus] ok pane=${pane} dt=${dt}ms`);
		return json({ ok: true });
	} catch (err) {
		const dt = Date.now() - t0;
		if (err instanceof FocusError) {
			console.log(`[focus] FocusError pane=${pane} dt=${dt}ms err=${err.message}`);
			return json({ ok: false, error: err.message }, { status: 410 });
		}
		const msg = err instanceof Error ? err.message : 'focus failed';
		console.log(`[focus] error pane=${pane} dt=${dt}ms err=${msg}`);
		return json({ ok: false, error: msg }, { status: 500 });
	}
};
