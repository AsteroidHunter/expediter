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
	markWorking,
	markWorkingIfMatch,
	resolveDeclineIfMatch,
	findByPane,
	dropPaneTicketsExcept,
	rebindPaneTicket,
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

test('upsert defaults working to false on the stored ticket', () => {
	const id = nextId();
	upsert({
		session_id: id,
		tmux_pane: '%1',
		cwd: '/tmp/proj',
		title: '',
		event_type: 'Stop',
		created_at: Date.now()
	});
	expect(list().find((t) => t.session_id === id)?.working).toBe(false);
	remove(id);
});

test('markWorking flips an idle ticket and returns true', () => {
	const id = nextId();
	upsert({
		session_id: id,
		tmux_pane: '%1',
		cwd: '/tmp/proj',
		title: '',
		event_type: 'Stop',
		created_at: Date.now()
	});
	expect(markWorking(id)).toBe(true);
	expect(list().find((t) => t.session_id === id)?.working).toBe(true);
	remove(id);
});

test('markWorking bumps created_at so the working tier sorts most-recent-first', () => {
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
	markWorking(id);
	const after = list().find((t) => t.session_id === id);
	expect(after?.created_at).toBeGreaterThanOrEqual(beforeCall);
	remove(id);
});

// Regression: a boot-scan / SessionStart-seeded Idle ticket that gets prompted
// must transition to Stop so the green working palette isn't desaturated by
// the .type-idle saturate(0) filter and the label doesn't read "IDLE" while
// claude is actively processing.
test('markWorking lifts an Idle ticket to Stop', () => {
	const id = nextId();
	upsert({
		session_id: id,
		tmux_pane: '%1',
		cwd: '/tmp/proj',
		title: '',
		event_type: 'Idle',
		created_at: Date.now()
	});
	markWorking(id);
	const t = list().find((x) => x.session_id === id);
	expect(t?.event_type).toBe('Stop');
	expect(t?.working).toBe(true);
	remove(id);
});

test('markWorking leaves non-Idle event_type unchanged', () => {
	const id = nextId();
	upsert({
		session_id: id,
		tmux_pane: '%1',
		cwd: '/tmp/proj',
		title: '',
		event_type: 'PermissionRequest',
		created_at: Date.now()
	});
	markWorking(id);
	expect(list().find((x) => x.session_id === id)?.event_type).toBe('PermissionRequest');
	remove(id);
});

test('markWorking returns false and does not notify on unknown session', () => {
	const snapshots: Ticket[][] = [];
	const unsub = subscribe((snap) => snapshots.push(snap));
	const before = snapshots.length;
	expect(markWorking(nextId())).toBe(false);
	expect(snapshots.length).toBe(before);
	unsub();
});

test('markWorkingIfMatch flips the ticket when created_at matches', () => {
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
	expect(markWorkingIfMatch(id, created_at)).toBe(true);
	expect(list().find((t) => t.session_id === id)?.working).toBe(true);
	remove(id);
});

test('markWorkingIfMatch returns false and leaves the ticket idle on mismatch', () => {
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
	expect(markWorkingIfMatch(id, created_at - 1)).toBe(false);
	expect(list().find((t) => t.session_id === id)?.working).toBe(false);
	remove(id);
});

test('markWorkingIfMatch returns false on unknown session', () => {
	expect(markWorkingIfMatch(nextId(), 0)).toBe(false);
});

test('resolveDeclineIfMatch lifts a PermissionRequest to Stop+idle when created_at matches', () => {
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
	const beforeCall = Date.now();
	expect(resolveDeclineIfMatch(id, created_at)).toBe(true);
	const t = list().find((t) => t.session_id === id);
	expect(t?.event_type).toBe('Stop');
	expect(t?.working).toBe(false);
	expect(t?.created_at).toBeGreaterThanOrEqual(beforeCall);
	remove(id);
});

test('resolveDeclineIfMatch returns false and leaves the ticket alone on mismatch', () => {
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
	expect(resolveDeclineIfMatch(id, created_at - 1)).toBe(false);
	const t = list().find((t) => t.session_id === id);
	expect(t?.event_type).toBe('PermissionRequest');
	expect(t?.working).toBe(false);
	expect(t?.created_at).toBe(created_at);
	remove(id);
});

test('resolveDeclineIfMatch returns false on unknown session', () => {
	expect(resolveDeclineIfMatch(nextId(), 0)).toBe(false);
});

test('upsert reactivates a working ticket: working cleared, event_type overrides priority', () => {
	const id = nextId();
	upsert({
		session_id: id,
		tmux_pane: '%1',
		cwd: '/tmp/proj',
		title: '',
		event_type: 'PermissionRequest',
		created_at: Date.now()
	});
	markWorking(id);
	expect(list().find((t) => t.session_id === id)?.working).toBe(true);

	// Notification has lower priority than PermissionRequest. On an idle ticket
	// it would be discarded; on a working one (reactivation path) it must win
	// and the ticket lifts back to idle.
	upsert({
		session_id: id,
		tmux_pane: '%1',
		cwd: '/tmp/proj',
		title: '',
		event_type: 'Notification',
		created_at: Date.now()
	});

	const t = list().find((t) => t.session_id === id);
	expect(t?.working).toBe(false);
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

test('list() places all idle tickets before any working tickets', () => {
	const idle = nextId();
	const working = nextId();
	// Stage working ticket with a more recent created_at than the idle one
	// to confirm tier dominates raw recency.
	upsert({
		session_id: idle,
		tmux_pane: '%1',
		cwd: '',
		title: '',
		event_type: 'Stop',
		created_at: Date.now() - 5_000
	});
	upsert({
		session_id: working,
		tmux_pane: '%2',
		cwd: '',
		title: '',
		event_type: 'Stop',
		created_at: Date.now()
	});
	markWorking(working);

	const ours = list().filter((t) => t.session_id === idle || t.session_id === working);
	expect(ours.map((t) => t.session_id)).toEqual([idle, working]);

	remove(idle);
	remove(working);
});

test('list() sorts within the idle tier by created_at desc', () => {
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

test('Idle is superseded by Notification (priority 0 > Idle -1)', () => {
	const id = nextId();
	upsert({
		session_id: id,
		tmux_pane: '%1',
		cwd: '',
		title: '',
		event_type: 'Idle',
		created_at: Date.now()
	});
	upsert({
		session_id: id,
		tmux_pane: '%1',
		cwd: '',
		title: '',
		event_type: 'Notification',
		created_at: Date.now()
	});
	expect(list().find((t) => t.session_id === id)?.event_type).toBe('Notification');
	remove(id);
});

test('Idle is superseded by Stop (priority 1 > Idle -1)', () => {
	const id = nextId();
	upsert({
		session_id: id,
		tmux_pane: '%1',
		cwd: '',
		title: '',
		event_type: 'Idle',
		created_at: Date.now()
	});
	upsert({
		session_id: id,
		tmux_pane: '%1',
		cwd: '',
		title: '',
		event_type: 'Stop',
		created_at: Date.now()
	});
	expect(list().find((t) => t.session_id === id)?.event_type).toBe('Stop');
	remove(id);
});

test('Idle is superseded by PermissionRequest (priority 2 > Idle -1)', () => {
	const id = nextId();
	upsert({
		session_id: id,
		tmux_pane: '%1',
		cwd: '',
		title: '',
		event_type: 'Idle',
		created_at: Date.now()
	});
	upsert({
		session_id: id,
		tmux_pane: '%1',
		cwd: '',
		title: '',
		event_type: 'PermissionRequest',
		created_at: Date.now()
	});
	expect(list().find((t) => t.session_id === id)?.event_type).toBe('PermissionRequest');
	remove(id);
});

test('findByPane returns the matching ticket when present', () => {
	const id = nextId();
	upsert({
		session_id: id,
		tmux_pane: '%42',
		cwd: '/tmp/proj',
		title: '',
		event_type: 'Stop',
		created_at: Date.now()
	});
	const found = findByPane('%42');
	expect(found?.session_id).toBe(id);
	remove(id);
});

test('findByPane returns undefined when no ticket matches', () => {
	expect(findByPane('%nonexistent')).toBeUndefined();
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

// ─── dropPaneTicketsExcept ───────────────────────────────────────────────────

test('dropPaneTicketsExcept removes same-pane tickets keyed differently, keeps the rest', () => {
	upsert({ session_id: 'keep', tmux_pane: '%9', cwd: '/a', title: 't', event_type: 'Stop', created_at: Date.now() });
	upsert({ session_id: 'stale', tmux_pane: '%9', cwd: '/a', title: 't', event_type: 'Idle', created_at: Date.now() });
	upsert({ session_id: 'other-pane', tmux_pane: '%8', cwd: '/b', title: 't', event_type: 'Stop', created_at: Date.now() });

	const removed = dropPaneTicketsExcept('%9', 'keep');
	expect(removed).toEqual(['stale']);
	expect(list().find((t) => t.session_id === 'keep')).toBeDefined();
	expect(list().find((t) => t.session_id === 'stale')).toBeUndefined();
	expect(list().find((t) => t.session_id === 'other-pane')).toBeDefined();
	remove('keep');
	remove('other-pane');
});

test('dropPaneTicketsExcept is a no-op when only the kept ticket exists', () => {
	upsert({ session_id: 'solo', tmux_pane: '%12', cwd: '/a', title: 't', event_type: 'Stop', created_at: Date.now() });
	expect(dropPaneTicketsExcept('%12', 'solo')).toEqual([]);
	expect(list().find((t) => t.session_id === 'solo')).toBeDefined();
	remove('solo');
});

// ─── rebindPaneTicket ────────────────────────────────────────────────────────

test('rebindPaneTicket re-keys a stale same-pane ticket to the live session_id, preserving fields', () => {
	upsert({ session_id: 'old-key', tmux_pane: '%20', cwd: '/proj', title: 'my session', event_type: 'Stop', created_at: 123 });
	const displaced = rebindPaneTicket('%20', 'new-key');
	expect(displaced).toEqual(['old-key']);
	const t = list().find((x) => x.tmux_pane === '%20');
	expect(t?.session_id).toBe('new-key');
	expect(t?.title).toBe('my session');
	expect(t?.cwd).toBe('/proj');
	expect(list().find((x) => x.session_id === 'old-key')).toBeUndefined();
	remove('new-key');
});

test('rebindPaneTicket returns [] and changes nothing when the pane has no ticket', () => {
	expect(rebindPaneTicket('%404', 'whatever')).toEqual([]);
	expect(list().find((t) => t.tmux_pane === '%404')).toBeUndefined();
});

test('rebindPaneTicket drops strays when a ticket is already keyed correctly', () => {
	upsert({ session_id: 'correct', tmux_pane: '%21', cwd: '/a', title: 't', event_type: 'Stop', created_at: Date.now() });
	upsert({ session_id: 'stray', tmux_pane: '%21', cwd: '/a', title: 't', event_type: 'Idle', created_at: Date.now() });
	const displaced = rebindPaneTicket('%21', 'correct');
	expect(displaced).toEqual(['stray']);
	expect(list().filter((t) => t.tmux_pane === '%21').length).toBe(1);
	expect(list().find((t) => t.session_id === 'correct')).toBeDefined();
	remove('correct');
});

// Pick the most-recently-created stale ticket: the rebind-comment claims this
// behavior but the existing tests only cover a single-stale case.
test('rebindPaneTicket re-keys the most-recently-created stale ticket when multiple share a pane', () => {
	upsert({ session_id: 'older-stale', tmux_pane: '%30', cwd: '/a', title: 'old title', event_type: 'Stop', created_at: 1000 });
	upsert({ session_id: 'newer-stale', tmux_pane: '%30', cwd: '/a', title: 'new title', event_type: 'Stop', created_at: 9999 });

	const displaced = rebindPaneTicket('%30', 'live-key');

	const survivor = list().find((t) => t.session_id === 'live-key');
	expect(survivor?.title).toBe('new title');
	expect(displaced).toContain('older-stale');
	expect(displaced).toContain('newer-stale');
	expect(list().filter((t) => t.tmux_pane === '%30').length).toBe(1);
	remove('live-key');
});

// ─── subscribe / notify discipline ───────────────────────────────────────────

test('subscribe delivers snapshots to multiple subscribers and unsubscribe removes the listener', () => {
	const a: Ticket[][] = [];
	const b: Ticket[][] = [];
	const unsubA = subscribe((snap) => a.push(snap));
	const unsubB = subscribe((snap) => b.push(snap));

	const id = nextId();
	upsert({ session_id: id, tmux_pane: '%1', cwd: '', title: '', event_type: 'Stop', created_at: Date.now() });
	expect(a.length > 0).toBe(true);
	expect(b.length > 0).toBe(true);
	expect(a.length).toBe(b.length);

	const aSnapsAtUnsub = a.length;
	const bSnapsAtUnsub = b.length;
	unsubB();
	upsert({ session_id: id, tmux_pane: '%1', cwd: '', title: '', event_type: 'PermissionRequest', created_at: Date.now() });
	expect(a.length).toBe(aSnapsAtUnsub + 1);
	expect(b.length).toBe(bSnapsAtUnsub); // B no longer notified

	unsubA();
	remove(id);
});

// Code-claimed quiescence: setCachedTitle should only notify when the ticket's
// title actually changes. Without this, a no-op refresh would spam SSE.
test('setCachedTitle does not notify subscribers when the title is unchanged', () => {
	const id = nextId();
	upsert({ session_id: id, tmux_pane: '%1', cwd: '', title: 'same title', event_type: 'Stop', created_at: Date.now() });
	setCachedTitle(id, 'same title');

	const snaps: Ticket[][] = [];
	const unsub = subscribe((s) => snaps.push(s));
	setCachedTitle(id, 'same title');
	expect(snaps.length).toBe(0);

	unsub();
	remove(id);
});

// Code-claimed: dropPaneTicketsExcept skips notify when it removes nothing.
test('dropPaneTicketsExcept does not notify subscribers when nothing is removed', () => {
	upsert({ session_id: 'only-keeper', tmux_pane: '%60', cwd: '/a', title: 't', event_type: 'Stop', created_at: Date.now() });

	const snaps: Ticket[][] = [];
	const unsub = subscribe((s) => snaps.push(s));
	const removed = dropPaneTicketsExcept('%60', 'only-keeper');
	expect(removed).toEqual([]);
	expect(snaps.length).toBe(0);

	unsub();
	remove('only-keeper');
});
