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

export function upsert(ticket: Ticket): void {
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
