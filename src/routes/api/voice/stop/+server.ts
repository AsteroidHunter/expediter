import { json, type RequestHandler } from '@sveltejs/kit';
import { sendKeys, ensurePaneInputReady, InjectError } from '$lib/tmux';
import { findByPane, setRecording } from '$lib/ticketStore';
import { voiceElapsedMs, stopWaitMs, clearVoice } from '$lib/server/voice';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// POST /api/voice/stop — stop the /voice tap dictation. A second Space toggles tap
// off, and Claude Code auto-submits the transcript once it has >=3 words. Claude
// debounces a stop within ~2s of the start tap, so if the user released early we
// wait out the floor before sending Space (never fire instantly).
//
// Refuses (409) when this pane has no recording the daemon started: tap's Space is
// a TOGGLE, so a blind Space on an idle pane STARTS a dictation — firing it on a
// desynced stop is how one client/daemon mismatch inverted every later action in
// the on-device test. Best-effort only past that gate: if the pane is no longer
// ready to receive input the recording is effectively over already, so we just
// clear our flag and report injected=false rather than erroring.
//
// Status contract: 400 bad body, 409 no active recording, 410 pane gone mid-
// inject, 500 otherwise.
export const POST: RequestHandler = async ({ request }) => {
	let body: { pane?: string };
	try {
		body = (await request.json()) as { pane?: string };
	} catch {
		return json({ ok: false, error: 'invalid json' }, { status: 400 });
	}
	const pane = body.pane;
	if (!pane) return json({ ok: false, error: 'missing pane' }, { status: 400 });

	// Active-recording gate BEFORE the readiness shell-out: with no start on
	// record there is nothing to stop and no flag to clear (start and the flag are
	// set together), so injecting could only desync further. Loud refusal — the
	// client surfaces the reason as a toast.
	const elapsed = voiceElapsedMs(pane);
	if (elapsed === null) {
		console.warn(`[voice] stop: no active recording for pane=${pane}; refusing to inject`);
		return json(
			{ ok: false, injected: false, error: 'no active /voice recording for this pane' },
			{ status: 409 }
		);
	}

	const clearFlag = () => {
		clearVoice(pane);
		const session_id = findByPane(pane)?.session_id;
		if (session_id) setRecording(session_id, false);
	};

	// Same copy-mode recovery as start: if the user scrolled up between recording and
	// tapping ✓, drop the pane back to the live prompt so the stop Space reaches
	// Claude instead of paging the scrollback (which would leave CC recording — a
	// desync). Any OTHER not-ready reason means the recording is effectively over, so
	// we just clear our flag and report injected=false rather than erroring.
	const readiness = await ensurePaneInputReady(pane);
	if (!readiness.ready) {
		console.warn(`[voice] stop: pane not ready (${readiness.reason}); clearing flag only`);
		clearFlag();
		return json({ ok: true, injected: false });
	}

	// Wait out the stop debounce if the user released within the floor.
	const wait = stopWaitMs(elapsed);
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
