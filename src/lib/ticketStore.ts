export type EventType = 'Stop' | 'PermissionRequest' | 'Notification';

export type Ticket = {
	session_id: string;
	tmux_pane: string;
	cwd: string;
	title: string;
	event_type: EventType;
	created_at: number;
};

const store = new Map<string, Ticket>();
const subscribers = new Set<(snapshot: Ticket[]) => void>();

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

export function list(): Ticket[] {
	return snapshot();
}

export function subscribe(cb: (snapshot: Ticket[]) => void): () => void {
	subscribers.add(cb);
	return () => {
		subscribers.delete(cb);
	};
}
