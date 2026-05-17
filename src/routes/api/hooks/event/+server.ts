import { json, type RequestHandler } from '@sveltejs/kit';
import {
	upsert,
	remove,
	removeIfMatch,
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
import { latestAssistantText } from '$lib/transcript';
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
	markRefreshStart(session_id);
	try {
		const text = await latestAssistantText(transcript_path).catch(() => null);
		if (!text) return;
		const title = await summarize(text);
		if (title) setCachedTitle(session_id, title);
	} catch (err) {
		console.warn('[refresh]', err);
	} finally {
		markRefreshEnd(session_id);
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
			incrementCounter(session_id);
			if (transcript_path && shouldRefresh(session_id, getRefreshInterval())) {
				void maybeRefreshTopic(session_id, transcript_path);
			}
		} else if (hook_event_name === 'SessionEnd') {
			deleteSessionTopic(session_id);
		}
		remove(session_id);
		return json({ ok: true, action: 'cleared' });
	}

	const eventType = SUMMARIZE_EVENTS[hook_event_name];
	if (!eventType) {
		return json({ ok: true, action: 'ignored', reason: 'unknown event' });
	}

	if (!tmux_pane) {
		return json({ ok: false, error: 'missing tmux_pane' }, { status: 400 });
	}

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
	// remove the ticket the moment it appears. The created_at guard makes a
	// late watcher fire a no-op if the ticket was already cleared/replaced.
	if (eventType === 'PermissionRequest' && transcript_path) {
		watchForDecline({
			transcriptPath: transcript_path,
			sessionId: session_id,
			createdAt: created_at,
			onDecline: () => {
				removeIfMatch(session_id, created_at);
			}
		});
	}

	return json({ ok: true, action: 'upserted' });
};
