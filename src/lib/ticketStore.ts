export type EventType = 'Stop' | 'PermissionRequest' | 'Notification';

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
	// True after a clear event (UserPromptSubmit / PostToolUse / PostToolUseFailure
	// / manual permission decline) — ticket sinks into the gray tier of the dock
	// but is not deleted. Cleared back to false on the next upsert (reactivation).
	inactive: boolean;
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
	// Two-tier sort: active tickets first, inactive second; within each tier,
	// newest created_at first.
	return Array.from(store.values()).sort((a, b) => {
		if (a.inactive !== b.inactive) return a.inactive ? 1 : -1;
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
	Notification: 0
};

export function upsert(ticket: Omit<Ticket, 'inactive'>): void {
	const existing = store.get(ticket.session_id);
	// EVENT_PRIORITY guards against same-cycle Notification clobbering a
	// PermissionRequest. Once a ticket is inactive the prior cycle is over, so
	// reactivation bypasses the priority check and the new event_type wins.
	if (
		existing &&
		!existing.inactive &&
		EVENT_PRIORITY[ticket.event_type] < EVENT_PRIORITY[existing.event_type]
	) {
		return;
	}
	store.set(ticket.session_id, { ...ticket, inactive: false });
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

// Soft-remove counterpart of remove(): flips the ticket to inactive instead of
// deleting it, and bumps created_at so the inactive tier sorts most-recently-
// handled first. Returns true if a ticket existed for this session.
export function markInactive(session_id: string): boolean {
	const existing = store.get(session_id);
	if (!existing) return false;
	store.set(session_id, { ...existing, inactive: true, created_at: Date.now() });
	notify();
	return true;
}

// Conditional soft-remove: mirror of removeIfMatch for the perpetual model.
// Used by the decline watcher to sink a declined permission ticket only if it
// is still the same ticket the watcher captured.
export function markInactiveIfMatch(session_id: string, created_at: number): boolean {
	const existing = store.get(session_id);
	if (!existing || existing.created_at !== created_at) return false;
	store.set(session_id, { ...existing, inactive: true, created_at: Date.now() });
	notify();
	return true;
}

export function list(): Ticket[] {
	return snapshot();
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
