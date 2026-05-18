import { json, type RequestHandler } from '@sveltejs/kit';
import {
	upsert,
	remove,
	markInactive,
	markInactiveIfMatch,
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
import { recentTranscriptText } from '$lib/transcript';
import { getRefreshInterval } from '$lib/config';
import { watchForDecline } from '$lib/declineWatcher';

const SUMMARIZE_EVENTS: Record<string, EventType> = {
	Stop: 'Stop',
	PermissionRequest: 'PermissionRequest',
	Notification: 'Notification'
};

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
async function maybeRefreshTopic(session_id: string, transcript_path: string): Promise<void> {
	// const t0 = Date.now();
	// const sid = session_id.slice(0, 8);
	// const log = (msg: string): void => {
	// 	console.log(`[trace:refresh sid=${sid} T+${Date.now() - t0}ms] ${msg}`);
	// };
	// log(`enter; transcript_path=${transcript_path}`);
	markRefreshStart(session_id);
	try {
		// log('reading transcript');
		const text = await recentTranscriptText(transcript_path).catch(() => null);
		// log(`transcript read; text=${text === null ? 'null' : `len=${text.length}`}`);
		if (!text) return;
		// log('calling summarize');
		const title = await summarize(text);
		// log(`summarize returned; title=${title === null ? 'null' : `"${title}"`}`);
		if (title) {
			setCachedTitle(session_id, title);
			// log('setCachedTitle called');
		}
	} catch (err) {
		// log(`caught: ${err}`);
		console.warn('[refresh]', err);
	} finally {
		markRefreshEnd(session_id);
		// log('markRefreshEnd; done');
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
		// events represent "handled, not gone" — sink the ticket into the inactive
		// tier of the dock instead.
		if (hook_event_name === 'SessionEnd') {
			deleteSessionTopic(session_id);
			remove(session_id);
			return json({ ok: true, action: 'cleared' });
		}
		markInactive(session_id);
		return json({ ok: true, action: 'marked_inactive' });
	}

	const eventType = SUMMARIZE_EVENTS[hook_event_name];
	if (!eventType) {
		return json({ ok: true, action: 'ignored', reason: 'unknown event' });
	}

	if (!tmux_pane) {
		return json({ ok: false, error: 'missing tmux_pane' }, { status: 400 });
	}

	// Title generation happens on UserPromptSubmit (see CLEAR_EVENTS branch above);
	// by the time we land here the cache is typically populated and getCachedTitle
	// below returns a non-empty string. If the UserPromptSubmit-side refresh failed
	// or hasn't completed yet, the ticket will still upsert with title="" and the
	// SSE live-patch in setCachedTitle will fill it in once the in-flight refresh
	// resolves.
	const created_at = Date.now();
	upsert({
		session_id,
		tmux_pane,
		cwd: cwd ?? '',
		title: getCachedTitle(session_id),
		event_type: eventType,
		created_at
	});

	// Claude Code emits no hook event when the user manually declines or
	// interrupts a permission prompt, so a PermissionRequest ticket would
	// otherwise sit on screen until the next UserPromptSubmit happens to clear
	// it. Tail the transcript JSONL for the rejection tool_result line and
	// soft-clear the ticket (mark inactive) the moment it appears. The
	// created_at guard makes a late watcher no-op if the ticket was already
	// cleared/replaced by a newer event for the same session_id.
	if (eventType === 'PermissionRequest' && transcript_path) {
		watchForDecline({
			transcriptPath: transcript_path,
			sessionId: session_id,
			createdAt: created_at,
			onDecline: () => {
				markInactiveIfMatch(session_id, created_at);
			}
		});
	}

	return json({ ok: true, action: 'upserted' });
};
