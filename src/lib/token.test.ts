import { test, expect, afterEach } from 'bun:test';
import { getServerToken, __setTokenForTesting } from './token';

afterEach(() => {
	__setTokenForTesting(null);
});

test('getServerToken returns a non-empty string', () => {
	const token = getServerToken();
	expect(typeof token).toBe('string');
	expect(token.length > 0).toBe(true);
});

test('repeated calls return the same string within a process', () => {
	const a = getServerToken();
	const b = getServerToken();
	const c = getServerToken();
	expect(a).toBe(b);
	expect(b).toBe(c);
});

test('returned string is 22 base64url characters (16 random bytes)', () => {
	const token = getServerToken();
	expect(/^[A-Za-z0-9_-]{22}$/.test(token)).toBe(true);
});

test('__setTokenForTesting injects a known value', () => {
	__setTokenForTesting('injected-test-token-22');
	expect(getServerToken()).toBe('injected-test-token-22');
});

test('__setTokenForTesting(null) clears cache; next call mints fresh', () => {
	__setTokenForTesting('first-value-22-chars-x');
	expect(getServerToken()).toBe('first-value-22-chars-x');
	__setTokenForTesting(null);
	const minted = getServerToken();
	expect(minted).not.toBe('first-value-22-chars-x');
	expect(/^[A-Za-z0-9_-]{22}$/.test(minted)).toBe(true);
});
