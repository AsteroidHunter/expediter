import { json, type RequestHandler } from '@sveltejs/kit';
import { sendKeys, ensurePaneInputReady, InjectError } from '$lib/tmux';
import { findByPane, setRecording } from '$lib/ticketStore';
import { markVoiceStart, checkVoiceTapVersion, VOICE_TAP_MIN_VERSION } from '$lib/server/voice';

// POST /api/voice/start — begin a built-in /voice tap dictation in the ticket's
// pane (laptop mic). Precondition: the pane is armed in tap mode persistently via
// Claude Code settings ({ "voice": { "enabled": true, "mode": "tap" } }) — tap is
// not the default and cannot be armed by injection. The route clears the prompt
// (C-u) first since tap's first Space only records on an empty prompt, then sends
// Space. Token-gated by the global hooks.server.ts gate like every /api/* route.
//
// Status contract: 400 bad body, 409 pane-not-ready or CC-too-old, 410 pane gone,
// 500 otherwise.
export const POST: RequestHandler = async ({ request }) => {
	let body: { pane?: string };
	try {
		body = (await request.json()) as { pane?: string };
	} catch {
		return json({ ok: false, error: 'invalid json' }, { status: 400 });
	}
	const pane = body.pane;
	if (!pane) return json({ ok: false, error: 'missing pane' }, { status: 400 });

	// tier-1 readiness guard — refuse to inject unless Claude Code is the pane's
	// foreground process. A pane scrolled up into copy-mode is NOT refused:
	// ensurePaneInputReady drops it back to the live prompt first, so hold-to-record
	// works even while the user is reading scrollback (it snaps their view to the
	// bottom — the dictation lands in the prompt there anyway). Still catches a
	// malformed/gone pane and a non-Claude foreground without shelling out for a bad id.
	const readiness = await ensurePaneInputReady(pane);
	if (!readiness.ready) {
		return json({ ok: false, ready: false, error: readiness.reason }, { status: 409 });
	}

	// Enforce the tap version floor: refuse if claude is definitively too old;
	// proceed with a warning if the version can't be resolved.
	const version = await checkVoiceTapVersion();
	if (version === 'too-old') {
		return json(
			{ ok: false, error: `Claude Code ${VOICE_TAP_MIN_VERSION}+ required for /voice tap mode` },
			{ status: 409 }
		);
	}
	if (version === 'unknown') {
		console.warn('[voice] could not verify Claude Code version; proceeding with /voice start');
	}

	try {
		// C-u clears the prompt so tap's first Space records; Space starts dictation.
		await sendKeys(pane, ['C-u', 'Space']);
	} catch (err) {
		if (err instanceof InjectError) {
			console.log(`[voice] start InjectError pane=${pane} err=${err.message}`);
			return json({ ok: false, error: err.message }, { status: 410 });
		}
		const msg = err instanceof Error ? err.message : 'voice start failed';
		console.log(`[voice] start error pane=${pane} err=${msg}`);
		return json({ ok: false, error: msg }, { status: 500 });
	}

	markVoiceStart(pane);
	const session_id = findByPane(pane)?.session_id;
	if (session_id) setRecording(session_id, true);

	return json({ ok: true });
};
