import { json, type RequestHandler } from '@sveltejs/kit';
import { sendKeys, paneAcceptsInput, InjectError } from '$lib/tmux';
import { findByPane, setRecording } from '$lib/ticketStore';
import { voiceElapsedMs, stopWaitMs, clearVoice } from '$lib/server/voice';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// POST /api/voice/stop — stop the /voice tap dictation. A second Space toggles tap
// off, and Claude Code auto-submits the transcript once it has >=3 words. Claude
// debounces a stop within ~2s of the start tap, so if the user released early we
// wait out the floor before sending Space (never fire instantly).
//
// Best-effort: if the pane is no longer ready to receive input the recording is
// effectively over already, so we just clear our flag and report injected=false
// rather than erroring — stopping should always succeed in clearing state.
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
		console.warn(`[voice] stop: pane not ready (${readiness.reason}); clearing flag only`);
		clearFlag();
		return json({ ok: true, injected: false });
	}

	// Wait out the stop debounce if the user released within the floor.
	const wait = stopWaitMs(voiceElapsedMs(pane));
	if (wait > 0) await sleep(wait);

	try {
		await sendKeys(pane, ['Space']); // stop + auto-submit (>=3 words, native)
	} catch (err) {
		clearFlag();
		if (err instanceof InjectError) {
			console.log(`[voice] stop InjectError pane=${pane} err=${err.message}`);
			return json({ ok: false, error: err.message }, { status: 410 });
		}
		const msg = err instanceof Error ? err.message : 'voice stop failed';
		console.log(`[voice] stop error pane=${pane} err=${msg}`);
		return json({ ok: false, error: msg }, { status: 500 });
	}

	clearFlag();
	return json({ ok: true, injected: true });
};
