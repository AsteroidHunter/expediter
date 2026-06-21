import { json, type RequestHandler } from '@sveltejs/kit';
import { sendKeys, paneAcceptsInput, InjectError } from '$lib/tmux';
import { findByPane, setRecording } from '$lib/ticketStore';
import { clearVoice, voiceElapsedMs } from '$lib/server/voice';

// POST /api/voice/cancel — abort the /voice dictation WITHOUT submitting. Stopping
// with Space would auto-submit, so cancel sends Escape instead: Escape is Claude Code's
// own /voice discard key — it drops out of dictation and deletes the transcript without
// sending. Confirmed in the CC 2.1.172 source: the voice key handler runs
// cancelRecording on Escape while voiceState==="recording" (logged "discarding without
// submit"). No Ctrl-U — Escape already discards the transcript, and the trailing C-u was
// what wiped hand-typed prompt text. Escape is a no-op unless a recording is genuinely
// active and past its warmup, so the client only fires this during the drain, well after
// the hold. Best-effort like stop: not-ready → clear our flag only.
//
// Unlike stop, "no active recording" is SUCCESS here (200, injected=false), not a 409:
// cancel's intent is "make sure nothing is recording", which is already true. The
// no-recording guard also keeps a stray Escape out of an idle pane.
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

	// No recording on record → nothing to discard; skip the injection so a stray
	// Escape can't disturb whatever the user is doing in an idle pane.
	if (voiceElapsedMs(pane) === null) {
		clearFlag();
		return json({ ok: true, injected: false });
	}

	const readiness = await paneAcceptsInput(pane);
	if (!readiness.ready) {
		console.warn(`[voice] cancel: pane not ready (${readiness.reason}); clearing flag only`);
		clearFlag();
		return json({ ok: true, injected: false });
	}

	try {
		// Escape is Claude's /voice discard — exits dictation and deletes the transcript
		// without submitting. No C-u (that wiped the prompt; Escape already discards).
		await sendKeys(pane, ['Escape']);
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
