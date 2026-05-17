import { test, expect } from 'bun:test';
import {
	incrementCounter,
	getCachedTitle,
	setCachedTitle,
	shouldRefresh,
	markRefreshStart,
	markRefreshEnd,
	deleteSessionTopic
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

test('shouldRefresh returns false before any prompt (counter === 0)', () => {
	const id = nextId();
	expect(shouldRefresh(id, 5)).toBe(false);
});

test('shouldRefresh returns true exactly at multiples of intervalN', () => {
	const id = nextId();
	for (let i = 1; i <= 4; i++) {
		incrementCounter(id);
		expect(shouldRefresh(id, 5)).toBe(false);
	}
	incrementCounter(id); // 5
	expect(shouldRefresh(id, 5)).toBe(true);

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
	for (let i = 0; i < 5; i++) incrementCounter(id);
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
	expect(shouldRefresh(id, 1)).toBe(false); // counter reset
});

test('setCachedTitle on unknown session lazily creates the entry', () => {
	const id = nextId();
	setCachedTitle(id, 'lazy-init');
	expect(getCachedTitle(id)).toBe('lazy-init');
});

test('markRefreshEnd on unknown session is a no-op (does not throw)', () => {
	expect(() => markRefreshEnd('never-touched')).not.toThrow();
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
