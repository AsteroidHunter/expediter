import { test, expect } from 'bun:test';
import { whimsicalName, WHIMSICAL_NAMES } from './whimsicalName';

test('returns the same name for the same session_id (determinism)', () => {
	const id = '00a93227-23fe-453c-a0e1-3b941045c7cb';
	expect(whimsicalName(id)).toBe(whimsicalName(id));
});

test('always returns a name from the curated list', () => {
	for (let i = 0; i < 200; i++) {
		const id = `session-${i}-${Math.random()}`;
		expect(WHIMSICAL_NAMES).toContain(whimsicalName(id));
	}
});

test('different session_ids generally produce different names (no all-collisions)', () => {
	const seen = new Set<string>();
	for (let i = 0; i < 500; i++) {
		seen.add(whimsicalName(`s-${i}`));
	}
	// 40 buckets, 500 ids — FNV-1a should hit a healthy spread, not collapse to
	// one or two buckets. >= half the list is a generous floor.
	expect(seen.size).toBeGreaterThanOrEqual(WHIMSICAL_NAMES.length / 2);
});

test('handles an empty session_id without throwing', () => {
	expect(WHIMSICAL_NAMES).toContain(whimsicalName(''));
});

test('all curated names are non-empty strings', () => {
	for (const name of WHIMSICAL_NAMES) {
		expect(typeof name).toBe('string');
		expect(name).not.toBe('');
	}
});
