import { test, expect } from 'bun:test';
import { resolveTransport, accessUrl } from './transport';

test('default is HTTPS when no flag and no saved preference', () => {
	expect(resolveTransport({})).toEqual({ transport: 'https', persist: false });
});

test('saved preference is honored, and is not re-persisted', () => {
	expect(resolveTransport({ saved: 'http' })).toEqual({ transport: 'http', persist: false });
	expect(resolveTransport({ saved: 'https' })).toEqual({ transport: 'https', persist: false });
});

test('an unrecognized saved value falls back to HTTPS', () => {
	expect(resolveTransport({ saved: 'gopher' })).toEqual({ transport: 'https', persist: false });
});

test('--http wins over saved and is sticky (persist)', () => {
	expect(resolveTransport({ httpFlag: true, saved: 'https' })).toEqual({
		transport: 'http',
		persist: true
	});
});

test('--https wins over saved and is sticky (persist)', () => {
	expect(resolveTransport({ httpsFlag: true, saved: 'http' })).toEqual({
		transport: 'https',
		persist: true
	});
});

test('conflicting --http --https throws', () => {
	let message = '';
	try {
		resolveTransport({ httpFlag: true, httpsFlag: true });
	} catch (err) {
		message = (err as Error).message;
	}
	expect(message).toBe('pass only one of --http / --https');
});

test('HTTPS URL uses the .local host and carries the token in the fragment', () => {
	const url = accessUrl({
		transport: 'https',
		dotLocalHost: 'as-machine.local',
		lanIp: '192.168.1.5', // ignored for https
		port: 5179,
		token: 'TOK'
	});
	expect(url).toBe('https://as-machine.local:5179/#TOK');
});

test('HTTP URL uses the raw LAN IP', () => {
	const url = accessUrl({
		transport: 'http',
		dotLocalHost: '',
		lanIp: '192.168.1.5',
		port: 5179,
		token: 'TOK'
	});
	expect(url).toBe('http://192.168.1.5:5179/#TOK');
});

test('HTTP with no LAN address returns null (caller prints guidance)', () => {
	const url = accessUrl({ transport: 'http', dotLocalHost: '', lanIp: null, port: 5179, token: 'TOK' });
	expect(url).toBeNull();
});
