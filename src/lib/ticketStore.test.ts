import { test, expect } from 'bun:test';
import {
	incrementCounter,
	getCachedTitle,
	setCachedTitle,
	shouldRefresh,
	markRefreshStart,
	markRefreshEnd,
	deleteSessionTopic,
	upsert,
	list,
	remove,
	removeIfMatch,
	markInactive,
	markInactiveIfMatch,
	subscribe,
	type Ticket
} from './ticketStore';

// Each test uses a unique session_id so module-level state doesn't leak between tests.
let testCounter = 0;
const nextId = (): string => `test-session-${++testCounter}`;

test('incrementCounter returns 1 on first call, increments thereafter', () => {
	const id = nextId();
	expect(incrementCounter(id)).toBe(1);
	expect(incrementCounter(id)).toBe(2);
	expect(incrementCounter(id)).toBe(3);
});

test('shouldRefresh returns true on a session with no entry (dev-server restart case)', () => {
	const id = nextId();
	expect(shouldRefresh(id, 5)).toBe(true);
});

test('shouldRefresh returns false when entry exists with counter === 0', () => {
	const id = nextId();
	markRefreshStart(id);
	markRefreshEnd(id);
	expect(shouldRefresh(id, 5)).toBe(false);
});

test('shouldRefresh returns true on the first prompt when cache is empty', () => {
	const id = nextId();
	incrementCounter(id); // 1
	expect(shouldRefresh(id, 5)).toBe(true);
});

test('shouldRefresh keeps firing while cache is empty (failed refresh retry)', () => {
	const id = nextId();
	for (let i = 1; i <= 4; i++) {
		incrementCounter(id);
		expect(shouldRefresh(id, 5)).toBe(true); // cache still empty → retry
	}
});

test('shouldRefresh settles to every-N cadence once cache is populated', () => {
	const id = nextId();
	incrementCounter(id); // 1
	expect(shouldRefresh(id, 5)).toBe(true);
	setCachedTitle(id, 'first title');

	for (let i = 2; i <= 4; i++) {
		incrementCounter(id);
		expect(shouldRefresh(id, 5)).toBe(false);
	}
	incrementCounter(id); // 5
	expect(shouldRefresh(id, 5)).toBe(true);

	setCachedTitle(id, 'second title');
	incrementCounter(id); // 6
	expect(shouldRefresh(id, 5)).toBe(false);

	for (let i = 7; i <= 9; i++) {
		incrementCounter(id);
		expect(shouldRefresh(id, 5)).toBe(false);
	}
	incrementCounter(id); // 10
	expect(shouldRefresh(id, 5)).toBe(true);
});

test('shouldRefresh returns false while refreshInFlight is true', () => {
	const id = nextId();
	incrementCounter(id); // 1 (cache empty → would refresh)
	expect(shouldRefresh(id, 5)).toBe(true);

	markRefreshStart(id);
	expect(shouldRefresh(id, 5)).toBe(false);

	markRefreshEnd(id);
	expect(shouldRefresh(id, 5)).toBe(true);
});

test('setCachedTitle + getCachedTitle round-trip', () => {
	const id = nextId();
	expect(getCachedTitle(id)).toBe('');
	setCachedTitle(id, 'refactored aggregator');
	expect(getCachedTitle(id)).toBe('refactored aggregator');
});

test('getCachedTitle returns empty string for unknown session', () => {
	expect(getCachedTitle('never-seen-before')).toBe('');
});

test('deleteSessionTopic clears all per-session state', () => {
	const id = nextId();
	incrementCounter(id);
	incrementCounter(id);
	setCachedTitle(id, 'whatever');
	markRefreshStart(id);

	deleteSessionTopic(id);

	expect(getCachedTitle(id)).toBe('');
});

test('setCachedTitle on unknown session lazily creates the entry', () => {
	const id = nextId();
	setCachedTitle(id, 'lazy-init');
	expect(getCachedTitle(id)).toBe('lazy-init');
});

test('markRefreshEnd on unknown session is a no-op (does not throw)', () => {
	expect(() => markRefreshEnd('never-touched')).not.toThrow();
});

test('setCachedTitle live-updates the displayed ticket for the same session', () => {
	const id = nextId();
	upsert({
		session_id: id,
		tmux_pane: '%1',
		cwd: '/tmp/proj',
		title: '',
		event_type: 'Stop',
		created_at: Date.now()
	});
	expect(list().find((t) => t.session_id === id)?.title).toBe('');

	setCachedTitle(id, 'topic arrived');

	expect(list().find((t) => t.session_id === id)?.title).toBe('topic arrived');
	remove(id);
});

test('setCachedTitle does not change the ticket store when no ticket exists for the session', () => {
	const id = nextId();
	setCachedTitle(id, 'cache only');
	expect(list().find((t) => t.session_id === id)).toBeUndefined();
	expect(getCachedTitle(id)).toBe('cache only');
});

test('removeIfMatch removes and returns true when created_at matches', () => {
	const id = nextId();
	const created_at = Date.now();
	upsert({
		session_id: id,
		tmux_pane: '%1',
		cwd: '/tmp/proj',
		title: '',
		event_type: 'PermissionRequest',
		created_at
	});

	expect(removeIfMatch(id, created_at)).toBe(true);
	expect(list().find((t) => t.session_id === id)).toBeUndefined();
});

test('removeIfMatch returns false and leaves the ticket when created_at differs', () => {
	const id = nextId();
	const created_at = Date.now();
	upsert({
		session_id: id,
		tmux_pane: '%1',
		cwd: '/tmp/proj',
		title: '',
		event_type: 'PermissionRequest',
		created_at
	});

	expect(removeIfMatch(id, created_at - 1)).toBe(false);
	expect(list().find((t) => t.session_id === id)?.created_at).toBe(created_at);
	remove(id);
});

test('removeIfMatch returns false when no ticket exists for the session', () => {
	expect(removeIfMatch(nextId(), 0)).toBe(false);
});

test('removeIfMatch notifies subscribers only when it actually removes', () => {
	const id = nextId();
	const created_at = Date.now();
	upsert({
		session_id: id,
		tmux_pane: '%1',
		cwd: '/tmp/proj',
		title: '',
		event_type: 'PermissionRequest',
		created_at
	});

	const snapshots: Ticket[][] = [];
	const unsub = subscribe((snap) => snapshots.push(snap));

	const noopBefore = snapshots.length;
	expect(removeIfMatch(id, created_at - 1)).toBe(false);
	expect(snapshots.length).toBe(noopBefore); // mismatch → no notify

	expect(removeIfMatch(id, created_at)).toBe(true);
	expect(snapshots.length).toBe(noopBefore + 1); // real remove → one notify

	unsub();
});

test('upsert defaults inactive to false on the stored ticket', () => {
	const id = nextId();
	upsert({
		session_id: id,
		tmux_pane: '%1',
		cwd: '/tmp/proj',
		title: '',
		event_type: 'Stop',
		created_at: Date.now()
	});
	expect(list().find((t) => t.session_id === id)?.inactive).toBe(false);
	remove(id);
});

test('markInactive flips an active ticket and returns true', () => {
	const id = nextId();
	upsert({
		session_id: id,
		tmux_pane: '%1',
		cwd: '/tmp/proj',
		title: '',
		event_type: 'Stop',
		created_at: Date.now()
	});
	expect(markInactive(id)).toBe(true);
	expect(list().find((t) => t.session_id === id)?.inactive).toBe(true);
	remove(id);
});

test('markInactive bumps created_at so the inactive tier sorts most-recent-first', () => {
	const id = nextId();
	const original = Date.now() - 10_000;
	upsert({
		session_id: id,
		tmux_pane: '%1',
		cwd: '/tmp/proj',
		title: '',
		event_type: 'Stop',
		created_at: original
	});
	const beforeCall = Date.now();
	markInactive(id);
	const after = list().find((t) => t.session_id === id);
	expect(after?.created_at).toBeGreaterThanOrEqual(beforeCall);
	remove(id);
});

test('markInactive returns false and does not notify on unknown session', () => {
	const snapshots: Ticket[][] = [];
	const unsub = subscribe((snap) => snapshots.push(snap));
	const before = snapshots.length;
	expect(markInactive(nextId())).toBe(false);
	expect(snapshots.length).toBe(before);
	unsub();
});

test('markInactiveIfMatch sinks the ticket when created_at matches', () => {
	const id = nextId();
	const created_at = Date.now();
	upsert({
		session_id: id,
		tmux_pane: '%1',
		cwd: '/tmp/proj',
		title: '',
		event_type: 'PermissionRequest',
		created_at
	});
	expect(markInactiveIfMatch(id, created_at)).toBe(true);
	expect(list().find((t) => t.session_id === id)?.inactive).toBe(true);
	remove(id);
});

test('markInactiveIfMatch returns false and leaves the ticket active on mismatch', () => {
	const id = nextId();
	const created_at = Date.now();
	upsert({
		session_id: id,
		tmux_pane: '%1',
		cwd: '/tmp/proj',
		title: '',
		event_type: 'PermissionRequest',
		created_at
	});
	expect(markInactiveIfMatch(id, created_at - 1)).toBe(false);
	expect(list().find((t) => t.session_id === id)?.inactive).toBe(false);
	remove(id);
});

test('markInactiveIfMatch returns false on unknown session', () => {
	expect(markInactiveIfMatch(nextId(), 0)).toBe(false);
});

test('upsert reactivates an inactive ticket: inactive cleared, event_type overrides priority', () => {
	const id = nextId();
	upsert({
		session_id: id,
		tmux_pane: '%1',
		cwd: '/tmp/proj',
		title: '',
		event_type: 'PermissionRequest',
		created_at: Date.now()
	});
	markInactive(id);
	expect(list().find((t) => t.session_id === id)?.inactive).toBe(true);

	// Notification has lower priority than PermissionRequest. On an active
	// ticket it would be discarded; on an inactive one (reactivation path) it
	// must win and the ticket goes back to active.
	upsert({
		session_id: id,
		tmux_pane: '%1',
		cwd: '/tmp/proj',
		title: '',
		event_type: 'Notification',
		created_at: Date.now()
	});

	const t = list().find((t) => t.session_id === id);
	expect(t?.inactive).toBe(false);
	expect(t?.event_type).toBe('Notification');
	remove(id);
});

test('upsert on an active ticket still honors EVENT_PRIORITY', () => {
	const id = nextId();
	upsert({
		session_id: id,
		tmux_pane: '%1',
		cwd: '/tmp/proj',
		title: '',
		event_type: 'PermissionRequest',
		created_at: Date.now()
	});
	upsert({
		session_id: id,
		tmux_pane: '%1',
		cwd: '/tmp/proj',
		title: '',
		event_type: 'Notification',
		created_at: Date.now()
	});
	expect(list().find((t) => t.session_id === id)?.event_type).toBe('PermissionRequest');
	remove(id);
});

test('list() places all active tickets before any inactive tickets', () => {
	const active = nextId();
	const inactive = nextId();
	// Stage inactive ticket with a more recent created_at than the active one
	// to confirm tier dominates raw recency.
	upsert({
		session_id: active,
		tmux_pane: '%1',
		cwd: '',
		title: '',
		event_type: 'Stop',
		created_at: Date.now() - 5_000
	});
	upsert({
		session_id: inactive,
		tmux_pane: '%2',
		cwd: '',
		title: '',
		event_type: 'Stop',
		created_at: Date.now()
	});
	markInactive(inactive);

	const ours = list().filter((t) => t.session_id === active || t.session_id === inactive);
	expect(ours.map((t) => t.session_id)).toEqual([active, inactive]);

	remove(active);
	remove(inactive);
});

test('list() sorts within the active tier by created_at desc', () => {
	const older = nextId();
	const newer = nextId();
	upsert({
		session_id: older,
		tmux_pane: '%1',
		cwd: '',
		title: '',
		event_type: 'Stop',
		created_at: 1_000
	});
	upsert({
		session_id: newer,
		tmux_pane: '%2',
		cwd: '',
		title: '',
		event_type: 'Stop',
		created_at: 2_000
	});
	const ours = list().filter((t) => t.session_id === older || t.session_id === newer);
	expect(ours.map((t) => t.session_id)).toEqual([newer, older]);
	remove(older);
	remove(newer);
});

test('multiple sessions are isolated', () => {
	const a = nextId();
	const b = nextId();
	incrementCounter(a);
	incrementCounter(a);
	incrementCounter(b);
	setCachedTitle(a, 'A title');
	setCachedTitle(b, 'B title');

	expect(getCachedTitle(a)).toBe('A title');
	expect(getCachedTitle(b)).toBe('B title');
	markRefreshStart(a);
	for (let i = 0; i < 3; i++) incrementCounter(b); // b reaches 4
	expect(shouldRefresh(a, 1)).toBe(false); // a is in flight
	incrementCounter(b); // 5
	expect(shouldRefresh(b, 5)).toBe(true);
});
