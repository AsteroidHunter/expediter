export type EventType = 'Stop' | 'PermissionRequest' | 'Notification' | 'Idle';

// `title` may be empty string when the async topic refresh has not yet
// populated the cache for this session; the frontend renders the title
// conditionally so empty values produce no element.
export type Ticket = {
	session_id: string;
	tmux_pane: string;
	cwd: string;
	title: string;
	event_type: EventType;
	created_at: number;
	// True while Claude is processing — set on UserPromptSubmit / PostToolUse /
	// PostToolUseFailure. Renders the ticket in the green "working" visual
	// (depressed + shimmer) and sorts it into the lower tier of the dock.
	// Cleared back to false on the next upsert (a fresh Stop / PermissionRequest /
	// Notification reactivates the ticket) or by resolveDeclineIfMatch.
	working: boolean;
	// True when the ticket's tmux session has >=1 attached client. Owned solely
	// by reconcile (boot scan / tmux hooks / slow poll) via setAttached — the
	// hook-event pipeline never sets it (upsert preserves the existing value).
	// Drives the Attached vs Detached split on the phone: detached cards render
	// greyed and re-attach on tap. Defaults true for a newly-upserted ticket.
	attached: boolean;
};

type SessionTopic = {
	counter: number;
	cachedTitle: string;
	refreshInFlight: boolean;
};

const store = new Map<string, Ticket>();
const sessionTopics = new Map<string, SessionTopic>();
const subscribers = new Set<(snapshot: Ticket[]) => void>();

function getOrCreateTopic(session_id: string): SessionTopic {
	let entry = sessionTopics.get(session_id);
	if (!entry) {
		entry = { counter: 0, cachedTitle: '', refreshInFlight: false };
		sessionTopics.set(session_id, entry);
	}
	return entry;
}

function snapshot(): Ticket[] {
	// Two-tier sort: idle tickets first (needing user attention), working tickets
	// second (Claude is processing, no action required); within each tier, newest
	// created_at first.
	return Array.from(store.values()).sort((a, b) => {
		if (a.working !== b.working) return a.working ? 1 : -1;
		return b.created_at - a.created_at;
	});
}

function notify(): void {
	const snap = snapshot();
	for (const cb of subscribers) cb(snap);
}

// PermissionRequest is the precise "blocked on a tool dialog" signal and must
// win the visual (red tint). Notification fires alongside it for the same
// dialog and would otherwise clobber the event_type back to a generic ticket.
// Stop sits in the middle: a real turn-end after a permission ask should
// supersede the PermissionRequest, but a duplicate Notification should not.
const EVENT_PRIORITY: Record<EventType, number> = {
	PermissionRequest: 2,
	Stop: 1,
	Notification: 0,
	Idle: -1
};

export function upsert(ticket: Omit<Ticket, 'working' | 'attached'>): void {
	const existing = store.get(ticket.session_id);
	// EVENT_PRIORITY guards against same-cycle Notification clobbering a
	// PermissionRequest. Once a ticket is working the prior cycle is over, so
	// reactivation bypasses the priority check and the new event_type wins.
	if (
		existing &&
		!existing.working &&
		EVENT_PRIORITY[ticket.event_type] < EVENT_PRIORITY[existing.event_type]
	) {
		return;
	}
	// `attached` is owned by reconcile, not the event pipeline: preserve the
	// existing value across re-upserts, defaulting true only for a brand-new
	// ticket. reconcile sets the real value via setAttached right after a seed.
	store.set(ticket.session_id, {
		...ticket,
		working: false,
		attached: existing?.attached ?? true
	});
	notify();
}

export function remove(session_id: string): boolean {
	const existed = store.delete(session_id);
	if (existed) notify();
	return existed;
}

// Conditional remove: only deletes the ticket if it still has the captured
// created_at. Lets a long-lived async observer (e.g. the transcript decline
// watcher) safely fire after the ticket it tracked may have been cleared and
// replaced by a newer one for the same session_id — the late call no-ops
// instead of removing the wrong ticket.
export function removeIfMatch(session_id: string, created_at: number): boolean {
	const existing = store.get(session_id);
	if (!existing || existing.created_at !== created_at) return false;
	store.delete(session_id);
	notify();
	return true;
}

// Flip the ticket into the working state instead of deleting it, and bump
// created_at so the working tier sorts most-recently-processing first. Returns
// true if a ticket existed for this session. An Idle ticket (boot-scan or
// SessionStart seed, no prior interaction) gets lifted to Stop on the way in:
// the .type-idle saturate(0) filter would otherwise desaturate the green
// working palette and the IDLE label is wrong while claude is actively
// processing. Stop is the natural rest state after the working pulse ends.
export function markWorking(session_id: string): boolean {
	const existing = store.get(session_id);
	if (!existing) return false;
	const event_type = existing.event_type === 'Idle' ? 'Stop' : existing.event_type;
	store.set(session_id, { ...existing, event_type, working: true, created_at: Date.now() });
	notify();
	return true;
}

// Conditional markWorking: mirror of removeIfMatch for the perpetual model.
// Currently unused — retained as the symmetric partner of markWorking in case a
// future async observer needs a created_at-guarded transition. Safe to drop if
// it never gains a caller.
export function markWorkingIfMatch(session_id: string, created_at: number): boolean {
	const existing = store.get(session_id);
	if (!existing || existing.created_at !== created_at) return false;
	store.set(session_id, { ...existing, working: true, created_at: Date.now() });
	notify();
	return true;
}

// Decline resolution: a manually-declined PermissionRequest lifts back to a
// Stop-yellow resting state (event_type='Stop', working=false) rather than
// sticking in the red/working visual. Bumps created_at so the resolved ticket
// sorts to the top of the idle tier, like a fresh Stop would. Guarded by
// created_at so a stale watcher fire (after the ticket has been superseded by
// a newer event for the same session_id) no-ops instead of clobbering.
export function resolveDeclineIfMatch(session_id: string, created_at: number): boolean {
	const existing = store.get(session_id);
	if (!existing || existing.created_at !== created_at) return false;
	store.set(session_id, {
		...existing,
		event_type: 'Stop',
		working: false,
		created_at: Date.now()
	});
	notify();
	return true;
}

// Flip only the attach flag, leaving event_type / working / title / created_at
// untouched. reconcile (boot scan, tmux hooks, slow poll) owns this flag; the
// hook-event pipeline owns the rest, so the two never fight over a ticket.
// No-ops (and skips notify) when the value is unchanged, keeping a steady-state
// reconcile silent. Returns true only when it actually changed something.
export function setAttached(session_id: string, attached: boolean): boolean {
	const existing = store.get(session_id);
	if (!existing || existing.attached === attached) return false;
	store.set(session_id, { ...existing, attached });
	notify();
	return true;
}

export function list(): Ticket[] {
	return snapshot();
}

// Linear scan to find any ticket bound to a given tmux_pane. Used by hook
// handlers to reconcile a boot-scan placeholder (synthetic key
// `pending:<pane_id>`) against the first authoritative event for that pane:
// the handler removes the placeholder, then upserts the real ticket keyed by
// session_id. Returns undefined when no ticket matches.
export function findByPane(tmux_pane: string): Ticket | undefined {
	for (const ticket of store.values()) {
		if (ticket.tmux_pane === tmux_pane) return ticket;
	}
	return undefined;
}

// Remove every ticket bound to tmux_pane whose key is not keepSessionId, and
// return the removed session_ids. One tmux pane runs one claude session, so a
// pane should hold at most one ticket; a stale one (left by a session that
// exited without SessionEnd, or whose live session_id diverged from the
// boot-scan/metadata key after a rewind) must be cleared before the
// authoritative event for that pane upserts the real ticket. Generalizes the
// old placeholder-only reconciliation — a `pending:<pane>` ticket is just one
// kind of mismatched key. Callers cancel any per-session side effects (decline
// watchers) for the returned ids.
export function dropPaneTicketsExcept(tmux_pane: string, keepSessionId: string): string[] {
	const removed: string[] = [];
	for (const [key, ticket] of store) {
		if (ticket.tmux_pane === tmux_pane && key !== keepSessionId) {
			store.delete(key);
			removed.push(key);
		}
	}
	if (removed.length) notify();
	return removed;
}

// Re-key a pane's existing ticket to sessionId, preserving all its fields.
// For events that update an existing ticket but never create one (the
// markWorking clear-events): if the pane's ticket is keyed by a stale
// session_id — e.g. a conversation rewind changed the live session_id while
// the dock ticket still carries the pre-rewind one — then markWorking(sessionId)
// would miss it and the ticket would never flip to working. Rebinding moves
// the ticket under the live session_id so the subsequent lookup succeeds.
// Drops any extra same-pane tickets. Returns the displaced session_ids
// (the old key plus any strays) for side-effect cleanup.
export function rebindPaneTicket(tmux_pane: string, sessionId: string): string[] {
	const samePane: Array<[string, Ticket]> = [];
	for (const [key, ticket] of store) {
		if (ticket.tmux_pane === tmux_pane) samePane.push([key, ticket]);
	}
	const displaced: string[] = [];
	let changed = false;
	const hasCorrect = samePane.some(([key]) => key === sessionId);
	if (!hasCorrect && samePane.length > 0) {
		// Re-key the most-recently-created stale ticket; it's the best proxy for
		// the live session's current state.
		let pick = samePane[0];
		for (const entry of samePane) {
			if (entry[1].created_at > pick[1].created_at) pick = entry;
		}
		store.delete(pick[0]);
		store.set(sessionId, { ...pick[1], session_id: sessionId });
		displaced.push(pick[0]);
		changed = true;
	}
	for (const [key] of samePane) {
		if (key !== sessionId && store.has(key)) {
			store.delete(key);
			displaced.push(key);
			changed = true;
		}
	}
	if (changed) notify();
	return displaced;
}

export function incrementCounter(session_id: string): number {
	const entry = getOrCreateTopic(session_id);
	entry.counter += 1;
	return entry.counter;
}

export function getCachedTitle(session_id: string): string {
	return sessionTopics.get(session_id)?.cachedTitle ?? '';
}

export function setCachedTitle(session_id: string, title: string): void {
	const entry = getOrCreateTopic(session_id);
	entry.cachedTitle = title;
	// Patch any currently-displayed ticket for this session so the body fills in
	// live (via SSE) when the async refresh completes, instead of waiting for the
	// next Stop / PermissionRequest event.
	const ticket = store.get(session_id);
	if (ticket && ticket.title !== title) {
		store.set(session_id, { ...ticket, title });
		notify();
	}
}

// Fire a refresh whenever (a) we have an empty cache and at least one prompt
// has happened (so brand-new sessions or expediter-started-mid-session get a
// topic immediately, and earlier failed refreshes get retried), or (b) we
// hit the regular every-N cadence once the cache is populated. A missing
// entry means the dev-server restarted mid-session; the caller already gated
// on transcript_path + SUMMARIZE_EVENT, so we know the session is real.
export function shouldRefresh(session_id: string, intervalN: number): boolean {
	const entry = sessionTopics.get(session_id);
	if (!entry) return true;
	if (entry.refreshInFlight || entry.counter === 0) return false;
	if (entry.cachedTitle === '') return true;
	return entry.counter % intervalN === 0;
}

export function markRefreshStart(session_id: string): void {
	const entry = getOrCreateTopic(session_id);
	entry.refreshInFlight = true;
}

export function markRefreshEnd(session_id: string): void {
	const entry = sessionTopics.get(session_id);
	if (entry) entry.refreshInFlight = false;
}

export function deleteSessionTopic(session_id: string): void {
	sessionTopics.delete(session_id);
}

export function subscribe(cb: (snapshot: Ticket[]) => void): () => void {
	subscribers.add(cb);
	return () => {
		subscribers.delete(cb);
	};
}
