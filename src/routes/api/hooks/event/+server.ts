import { json, type RequestHandler } from '@sveltejs/kit';
import { upsert, remove, patchTitle, type EventType } from '$lib/ticketStore';
import { summarize } from '$lib/summarize';
import { latestAssistantText } from '$lib/transcript';

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

	// TEMP instrumentation — confirm which hooks actually fire when a permission
	// is declined / interrupted in Claude Code. Remove after diagnosis.
	console.log(
		`[hook] ${hook_event_name} session=${session_id.slice(0, 8)} pane=${tmux_pane ?? '<none>'}`
	);

	if (CLEAR_EVENTS.has(hook_event_name)) {
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

	// Upsert with a placeholder title BEFORE awaiting summarize() — otherwise a
	// clear event for the same session_id that arrives during the summarize
	// await would remove() nothing, and the late upsert would land a phantom
	// ticket that nothing clears. The placeholder also makes red permission
	// tickets visible instantly instead of after Haiku latency.
	const created_at = Date.now();
	upsert({
		session_id,
		tmux_pane,
		cwd: cwd ?? '',
		title: '(awaiting)',
		event_type: eventType,
		created_at
	});

	let title = '(awaiting)';
	if (transcript_path) {
		const text = await latestAssistantText(transcript_path).catch(() => null);
		if (text) {
			try {
				title = await summarize(text);
			} catch (err) {
				const msg = err instanceof Error ? err.message : 'summarize failed';
				title = msg.includes('ANTHROPIC_API_KEY') ? '(no api key)' : '(summary failed)';
			}
		}
	}

	const patched = patchTitle(session_id, created_at, title);
	return json({ ok: true, action: patched ? 'upserted' : 'cleared-mid-flight', title });
};
