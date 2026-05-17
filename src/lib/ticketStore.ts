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
	return Array.from(store.values()).sort((a, b) => b.created_at - a.created_at);
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

export function upsert(ticket: Ticket): void {
	const existing = store.get(ticket.session_id);
	if (existing && EVENT_PRIORITY[ticket.event_type] < EVENT_PRIORITY[existing.event_type]) {
		return;
	}
	store.set(ticket.session_id, ticket);
	notify();
}

export function remove(session_id: string): boolean {
	const existed = store.delete(session_id);
	if (existed) notify();
	return existed;
}

// TODO Phase 4: remove this helper once the synchronous summarize call (and
// its created_at-guarded patch) goes away. Kept here in the interim so
// +server.ts compiles between phases.
export function patchTitle(session_id: string, created_at: number, title: string): boolean {
	const existing = store.get(session_id);
	if (!existing || existing.created_at !== created_at) return false;
	store.set(session_id, { ...existing, title });
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
}

export function shouldRefresh(session_id: string, intervalN: number): boolean {
	const entry = sessionTopics.get(session_id);
	if (!entry || entry.refreshInFlight || entry.counter === 0) return false;
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
