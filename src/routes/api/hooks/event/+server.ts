import { json, type RequestHandler } from '@sveltejs/kit';
import {
	upsert,
	remove,
	markWorking,
	findByPane,
	resolveDeclineIfMatch,
	incrementCounter,
	getCachedTitle,
	setCachedTitle,
	shouldRefresh,
	markRefreshStart,
	markRefreshEnd,
	deleteSessionTopic,
	type EventType
} from '$lib/ticketStore';
import { summarize } from '$lib/summarize';
import { recentTranscriptText, latestCustomTitle } from '$lib/transcript';
import { getRefreshInterval, getTitleSource } from '$lib/config';
import { watchForDecline } from '$lib/declineWatcher';
import { whimsicalName } from '$lib/whimsicalName';
import { recordSession, forgetSession } from '$lib/server/sessionsStore';

const SUMMARIZE_EVENTS: Record<string, EventType> = {
	Stop: 'Stop',
	PermissionRequest: 'PermissionRequest',
	Notification: 'Notification'
};

// Tracks the cancel handle for each session_id's active decline watcher so we
// can stop it the moment the PR is approved or superseded by any other event.
// Without this the watcher leaks for DEFAULT_TIMEOUT_MS (1h, see
// declineWatcher.ts) every time a PR is approved rather than declined.
const activeDeclineWatchers = new Map<string, () => void>();

function cancelActiveDeclineWatcher(session_id: string): void {
	const cancel = activeDeclineWatchers.get(session_id);
	if (cancel) {
		cancel();
		activeDeclineWatchers.delete(session_id);
	}
}

const CLEAR_EVENTS = new Set([
	'UserPromptSubmit',
	'PostToolUse',
	'PostToolUseFailure',
	'SessionEnd'
]);

type HookPayload = {
	hook_event_name?: string;
	session_id?: string;
	transcript_path?: string;
	cwd?: string;
	tmux_pane?: string;
};

// Fire-and-forget topic refresh. Caller never awaits. The try/finally pair
// guarantees `refreshInFlight` is cleared even if summarize or transcript-read
// throws, so a hang or error doesn't leave the session permanently un-refreshable.
// Branches on getTitleSource(): chat-title mode reads the JSONL for the latest
// custom-title line and skips the LLM call entirely; haiku mode runs the
// original summarize path.
async function maybeRefreshTopic(session_id: string, transcript_path: string): Promise<void> {
	markRefreshStart(session_id);
	try {
		if (getTitleSource() === 'chat-title') {
			const title = await latestCustomTitle(transcript_path).catch(() => null);
			if (title) setCachedTitle(session_id, title);
			return;
		}
		const text = await recentTranscriptText(transcript_path).catch(() => null);
		if (!text) return;
		const title = await summarize(text);
		if (title) setCachedTitle(session_id, title);
	} catch (err) {
		console.warn('[refresh]', err);
	} finally {
		markRefreshEnd(session_id);
	}
}

// Returns the cached title if one exists, else a deterministic whimsical name
// (chat-title mode only — haiku mode leaves the title empty so the existing
// SSE live-patch fills it in when summarize resolves).
function resolveDisplayTitle(session_id: string): string {
	const cached = getCachedTitle(session_id);
	if (cached) return cached;
	if (getTitleSource() === 'chat-title') return whimsicalName(session_id);
	return '';
}

// Removes a boot-scan placeholder ticket bound to this pane, if one exists.
// Placeholders are keyed by the synthetic `pending:<pane_id>` session_id; real
// tickets are keyed by the authoritative session_id. When the first real hook
// for a previously-unidentified pane arrives, the placeholder must be cleared
// before the real ticket is upserted — otherwise both coexist briefly.
function reconcilePlaceholder(tmux_pane: string): void {
	const existing = findByPane(tmux_pane);
	if (existing && existing.session_id.startsWith('pending:')) {
		remove(existing.session_id);
	}
}

export const POST: RequestHandler = async ({ request }) => {
	let payload: HookPayload;
	try {
		payload = (await request.json()) as HookPayload;
	} catch {
		return json({ ok: false, error: 'invalid json' }, { status: 400 });
	}

	const { hook_event_name, session_id, transcript_path, cwd, tmux_pane } = payload;
	if (!hook_event_name || !session_id) {
		return json({ ok: false, error: 'missing hook_event_name or session_id' }, { status: 400 });
	}

	// Any subsequent event for this session supersedes a still-running decline
	// watcher from a prior PermissionRequest — approve, decline-detected, fresh
	// PR, Stop, Notification, or SessionEnd. Cancel before branching so each
	// branch can start fresh; the PR branch below will register a new watcher.
	cancelActiveDeclineWatcher(session_id);

	if (hook_event_name === 'SessionStart') {
		if (!tmux_pane) {
			return json({ ok: false, error: 'missing tmux_pane' }, { status: 400 });
		}
		if (!transcript_path) {
			return json({ ok: false, error: 'missing transcript_path' }, { status: 400 });
		}
		// If the boot scan seeded a `pending:<pane>` placeholder for this pane,
		// remove it before upserting the authoritative ticket. Otherwise both
		// would coexist for one frame.
		reconcilePlaceholder(tmux_pane);
		// Persist before upserting so a daemon crash between the two leaves the
		// session discoverable on the next boot scan. Awaited so the on-disk
		// side effect is observable to anything that polls sessions.json right
		// after POST returns (notably the test suite); the write is microseconds
		// for a tiny JSON payload, not a latency concern.
		await recordSession({
			session_id,
			tmux_pane,
			cwd: cwd ?? '',
			transcript_path
		}).catch((e) => console.warn('[sessionStart] recordSession failed', e));
		upsert({
			session_id,
			tmux_pane,
			cwd: cwd ?? '',
			title: resolveDisplayTitle(session_id),
			event_type: 'Idle',
			created_at: Date.now()
		});
		// Fire-and-forget title pre-fill. In chat-title mode resolveDisplayTitle
		// already returned a whimsical fallback; this upgrades it as soon as the
		// jsonl has a real custom-title line. setCachedTitle live-patches any
		// currently-displayed ticket for this session (see ticketStore.ts).
		void latestCustomTitle(transcript_path)
			.then((t) => {
				if (t) setCachedTitle(session_id, t);
			})
			.catch(() => {});
		return json({ ok: true, action: 'session_started' });
	}

	if (CLEAR_EVENTS.has(hook_event_name)) {
		if (hook_event_name === 'UserPromptSubmit') {
			// Increment the counter (drives the every-N cadence) and kick off the
			// summarize refresh here, against the just-submitted user message.
			// Firing from UserPromptSubmit (instead of Stop) lets summarize run in
			// parallel with the assistant's work, so the title is already cached by
			// the time the ticket upserts on Stop / PermissionRequest / Notification.
			// recentTranscriptText reads both user and assistant turns, so summarizing
			// the user's prompt + prior context is sufficient — assistant text is not
			// required.
			incrementCounter(session_id);
			if (transcript_path && shouldRefresh(session_id, getRefreshInterval())) {
				void maybeRefreshTopic(session_id, transcript_path);
			}
		}
		// SessionEnd is the only terminal clear: the Claude session is genuinely
		// over, so hard-delete the ticket and its topic state. The other clear
		// events represent "Claude is processing" — flip the ticket into the
		// working tier of the dock instead.
		if (hook_event_name === 'SessionEnd') {
			// Awaited (rather than fire-and-forget) so callers that observe
			// sessions.json immediately after POST returns see a consistent
			// state — and so it can't race a subsequent recordSession write.
			await forgetSession(session_id).catch((e) =>
				console.warn('[sessionEnd] forgetSession failed', e)
			);
			deleteSessionTopic(session_id);
			remove(session_id);
			return json({ ok: true, action: 'cleared' });
		}
		markWorking(session_id);
		return json({ ok: true, action: 'marked_working' });
	}

	const eventType = SUMMARIZE_EVENTS[hook_event_name];
	if (!eventType) {
		return json({ ok: true, action: 'ignored', reason: 'unknown event' });
	}

	if (!tmux_pane) {
		return json({ ok: false, error: 'missing tmux_pane' }, { status: 400 });
	}

	// If a boot-scan placeholder is bound to this pane, remove it before the
	// real ticket lands. Covers the case where a pre-existing unnamed session's
	// first hook is a Stop / PermissionRequest / Notification (not SessionStart),
	// e.g. for sessions that were running before install.
	reconcilePlaceholder(tmux_pane);

	// Title generation happens on UserPromptSubmit (see CLEAR_EVENTS branch above);
	// by the time we land here the cache is typically populated. In chat-title
	// mode an empty cache resolves to a deterministic whimsical name so the
	// ticket never shows blank; once a real title arrives the SSE live-patch in
	// setCachedTitle replaces it.
	const created_at = Date.now();
	upsert({
		session_id,
		tmux_pane,
		cwd: cwd ?? '',
		title: resolveDisplayTitle(session_id),
		event_type: eventType,
		created_at
	});

	// Claude Code emits no hook event when the user manually declines or
	// interrupts a permission prompt, so a PermissionRequest ticket would
	// otherwise sit on screen until the next UserPromptSubmit happens to clear
	// it. Tail the transcript JSONL for the rejection tool_result line and lift
	// the ticket back to Stop+yellow the moment it appears. The created_at
	// guard makes a late watcher no-op if the ticket was already cleared or
	// replaced by a newer event for the same session_id. The cancel handle is
	// stored so an approved (not declined) PR doesn't leak the watcher — the
	// next event for this session cancels via cancelActiveDeclineWatcher above.
	if (eventType === 'PermissionRequest' && transcript_path) {
		const cancel = watchForDecline({
			transcriptPath: transcript_path,
			sessionId: session_id,
			createdAt: created_at,
			onDecline: () => {
				resolveDeclineIfMatch(session_id, created_at);
				activeDeclineWatchers.delete(session_id);
			}
		});
		activeDeclineWatchers.set(session_id, cancel);
	}

	return json({ ok: true, action: 'upserted' });
};
