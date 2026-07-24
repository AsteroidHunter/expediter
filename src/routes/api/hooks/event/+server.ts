import { json, type RequestHandler } from '@sveltejs/kit';
import {
	upsert,
	remove,
	markWorking,
	dropPaneTicketsExcept,
	rebindPaneTicket,
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
import { recentTranscriptText, localChatTitle } from '$lib/transcript';
import { getRefreshInterval, getTitleSource } from '$lib/config';
import { watchForDecline } from '$lib/declineWatcher';
import { whimsicalName } from '$lib/whimsicalName';
import { recordSession, forgetSession, updateSessionTitle } from '$lib/server/sessionsStore';
import { resolveRemotePane } from '$lib/server/sshCorrelation';
import { resolveAgentPid } from '$lib/server/bootScan';
import { agentForPath, type Agent } from '$lib/agent';

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
	// Remote mode (hook running on another box, reaching us through the
	// reverse ssh tunnel): `remote: true` plus the far side's verbatim
	// $SSH_CONNECTION in place of tmux_pane, and optionally the latest
	// custom-title read from the far side's own transcript.
	remote?: boolean;
	ssh_connection?: string;
	title?: string;
};

// Fire-and-forget topic refresh. Caller never awaits. The try/finally pair
// guarantees `refreshInFlight` is cleared even if summarize or transcript-read
// throws, so a hang or error doesn't leave the session permanently un-refreshable.
// Codex sessions always take the explicit thread-name read (session_index.jsonl
// / threads.name via localChatTitle) regardless of title_source — a codex ticket must never
// depend on a `claude -p` spawn. Claude keeps the configured behavior:
// chat-title reads the JSONL's latest custom-title line; haiku runs the
// original summarize path.
async function maybeRefreshTopic(
	session_id: string,
	transcript_path: string,
	agent: Agent
): Promise<void> {
	markRefreshStart(session_id);
	try {
		if (agent === 'codex' || getTitleSource() === 'chat-title') {
			const title = await localChatTitle(agent, session_id, transcript_path).catch(() => null);
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

function cancelWatchers(session_ids: string[]): void {
	for (const id of session_ids) cancelActiveDeclineWatcher(id);
}

export const POST: RequestHandler = async ({ request }) => {
	let payload: HookPayload;
	try {
		payload = (await request.json()) as HookPayload;
	} catch {
		return json({ ok: false, error: 'invalid json' }, { status: 400 });
	}

	const { hook_event_name, session_id, transcript_path, cwd } = payload;
	if (!hook_event_name || !session_id) {
		return json({ ok: false, error: 'missing hook_event_name or session_id' }, { status: 400 });
	}

	// Which agent fired this event, derived from transcript_path's segment
	// (`/.claude/` vs `/.codex/`). Remote payloads carry their far-side path —
	// stored, never read — which is exactly enough to classify. Events without
	// a transcript_path pass `undefined` into upsert, which preserves the
	// ticket's existing agent (and defaults claude for a brand-new ticket).
	const agent = transcript_path ? (agentForPath(transcript_path) ?? undefined) : undefined;

	// Remote events carry no tmux_pane — the far side can't know it. Resolve
	// the local ssh pane from the payload's $SSH_CONNECTION before branching,
	// so every branch below sees a pane exactly as it would for a local event.
	// Correlation failure is a loud 422 and no ticket: an unfocusable ticket
	// violates the product's core promise (decision 10 — no fallbacks). Events
	// with neither identifier still hit the existing `missing tmux_pane` 400s.
	const remote = payload.remote === true;
	let tmux_pane = payload.tmux_pane;
	if (remote && !tmux_pane && payload.ssh_connection) {
		const resolution = await resolveRemotePane(session_id, payload.ssh_connection);
		if (!resolution.ok) {
			console.warn(
				`[remote] ssh correlation failed at step=${resolution.step} session=${session_id.slice(0, 8)}: ${resolution.detail}`
			);
			return json(
				{ ok: false, error: `ssh correlation failed: ${resolution.step}` },
				{ status: 422 }
			);
		}
		tmux_pane = resolution.paneId;
	}

	// Remote title passthrough (decision 7): the Mac can't read a remote
	// transcript, so the hook ships the far side's latest custom-title in the
	// payload. Cache it before any branch — resolveDisplayTitle prefers the
	// cache, and setCachedTitle live-patches a currently-displayed ticket.
	// Persist it too (decision 13) so a daemon restart reseeds the ticket with
	// its title; SessionStart skips the extra write because recordSession
	// below stores the title with the full entry.
	const payloadTitle = remote && typeof payload.title === 'string' ? payload.title.trim() : '';
	if (payloadTitle) {
		setCachedTitle(session_id, payloadTitle);
		if (hook_event_name !== 'SessionStart') {
			void updateSessionTitle(session_id, payloadTitle).catch((e) =>
				console.warn('[remote] updateSessionTitle failed', e)
			);
		}
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
		// Clear any ticket bound to this pane under a different key (boot-scan
		// placeholder, or a prior/diverged session_id) before upserting the
		// authoritative one, so the pane never shows two tickets.
		cancelWatchers(dropPaneTicketsExcept(tmux_pane, session_id));
		// Pid guard for boot recovery (local sessions only): record the agent
		// process's pid so a later boot scan accepts this entry only while that
		// pid is alive and still under this pane. Skipped for remote sessions —
		// the agent process lives on the far box, and remote entries keep the
		// pane-existence guard (remote decisions 5/6). Resolution failure just
		// omits the field: boot recovery degrades to the placeholder.
		const agent_pid = remote ? null : await resolveAgentPid(tmux_pane);
		// Persist before upserting so a daemon crash between the two leaves the
		// session discoverable on the next boot scan. Awaited so the on-disk
		// side effect is observable to anything that polls sessions.json right
		// after POST returns (notably the test suite); the write is microseconds
		// for a tiny JSON payload, not a latency concern.
		await recordSession({
			session_id,
			tmux_pane,
			cwd: cwd ?? '',
			transcript_path,
			...(remote ? { remote: true } : {}),
			...(payloadTitle ? { title: payloadTitle } : {}),
			...(agent_pid ? { agent_pid } : {})
		}).catch((e) => console.warn('[sessionStart] recordSession failed', e));
		upsert({
			session_id,
			tmux_pane,
			cwd: cwd ?? '',
			title: resolveDisplayTitle(session_id),
			event_type: 'Idle',
			created_at: Date.now(),
			remote,
			agent
		});
		// Fire-and-forget title pre-fill. In chat-title mode resolveDisplayTitle
		// already returned a whimsical fallback; this upgrades it as soon as the
		// agent's title source has one (claude: the jsonl's custom-title line;
		// codex: its explicit thread name). setCachedTitle live-patches any
		// currently-displayed ticket for this session (see ticketStore.ts).
		// Skipped for remote sessions: transcript_path is a far-side path the
		// containment guard would reject anyway — the payload title (cached
		// above) is a remote ticket's only title source (decision 9).
		if (!remote) {
			void localChatTitle(agent ?? 'claude', session_id, transcript_path)
				.then((t) => {
					if (t) setCachedTitle(session_id, t);
				})
				.catch(() => {});
		}
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
			// Remote sessions skip the topic refresh: transcript_path points at
			// the far box, so both the chat-title read and the summarize read
			// would fail the containment guard (decision 9).
			if (transcript_path && !remote && shouldRefresh(session_id, getRefreshInterval())) {
				void maybeRefreshTopic(session_id, transcript_path, agent ?? 'claude');
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
		// UserPromptSubmit / PostToolUse / PostToolUseFailure flip the pane's
		// ticket to working. If that ticket is keyed by a stale session_id (a
		// rewind changed the live session_id while the dock ticket kept the
		// boot-scan/metadata one), markWorking would miss it and the ticket
		// would stay idle until the next Stop re-created it. Rebind the pane's
		// ticket to the live session_id first so markWorking lands.
		if (tmux_pane) cancelWatchers(rebindPaneTicket(tmux_pane, session_id));
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

	// Clear any ticket bound to this pane under a different key before the real
	// ticket lands — a boot-scan placeholder, or a stale/diverged session_id
	// (e.g. after a rewind) that would otherwise leave a second ticket for the
	// same pane.
	cancelWatchers(dropPaneTicketsExcept(tmux_pane, session_id));

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
		created_at,
		remote,
		agent
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
	// Remote tickets get no watcher: the transcript to tail is on the far box
	// (decision 9), so a manually-declined remote PR clears on the session's
	// next event instead — the same far-end blindness accepted in decision 5.
	if (eventType === 'PermissionRequest' && transcript_path && !remote) {
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
