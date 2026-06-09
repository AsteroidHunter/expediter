import { json, type RequestHandler } from '@sveltejs/kit';
import { sendKeys, paneAcceptsInput, InjectError } from '$lib/tmux';
import { findByPane, setRecording } from '$lib/ticketStore';
import { clearVoice } from '$lib/server/voice';

// POST /api/voice/cancel — abort the /voice tap dictation WITHOUT submitting.
// Stopping with Space would auto-submit, so cancel instead sends Escape to drop out
// of dictation and Ctrl-U to wipe any partial transcript left in the prompt. The
// exact discard keys are Open Question 1 — Esc/C-u is the working assumption,
// pending a live check against /voice. Best-effort like stop: not-ready → clear our
// flag only.
export const POST: RequestHandler = async ({ request }) => {
	let body: { pane?: string };
	try {
		body = (await request.json()) as { pane?: string };
	} catch {
		return json({ ok: false, error: 'invalid json' }, { status: 400 });
	}
	const pane = body.pane;
	if (!pane) return json({ ok: false, error: 'missing pane' }, { status: 400 });

	const clearFlag = () => {
		clearVoice(pane);
		const session_id = findByPane(pane)?.session_id;
		if (session_id) setRecording(session_id, false);
	};

	const readiness = await paneAcceptsInput(pane);
	if (!readiness.ready) {
		console.warn(`[voice] cancel: pane not ready (${readiness.reason}); clearing flag only`);
		clearFlag();
		return json({ ok: true, injected: false });
	}

	try {
		// Escape exits dictation without submitting; C-u clears any partial text.
		await sendKeys(pane, ['Escape', 'C-u']);
	} catch (err) {
		clearFlag();
		if (err instanceof InjectError) {
			console.log(`[voice] cancel InjectError pane=${pane} err=${err.message}`);
			return json({ ok: false, error: err.message }, { status: 410 });
		}
		const msg = err instanceof Error ? err.message : 'voice cancel failed';
		console.log(`[voice] cancel error pane=${pane} err=${msg}`);
		return json({ ok: false, error: msg }, { status: 500 });
	}

	clearFlag();
	return json({ ok: true, injected: true });
};
