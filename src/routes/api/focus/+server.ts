import { json, type RequestHandler } from '@sveltejs/kit';
import { focusPane, FocusError } from '$lib/tmux';

// Gated on DEBUG_FOCUS so happy-path request/ok logs only run when diagnosing
// tap-to-focus locally. Error-path console.log calls below stay unconditional
// so failed taps are always visible.
const debugFocus = (msg: string): void => {
	if (process.env.DEBUG_FOCUS) console.log(msg);
};

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
	debugFocus(`[focus] req pane=${pane}`);
	try {
		await focusPane(pane);
		const dt = Date.now() - t0;
		debugFocus(`[focus] ok pane=${pane} dt=${dt}ms`);
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
