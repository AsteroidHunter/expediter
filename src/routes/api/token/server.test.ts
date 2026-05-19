import { test, expect, beforeEach, afterEach } from 'bun:test';
import { GET } from './+server';
import { __setTokenForTesting } from '../../../lib/token';

const TEST_TOKEN = 'CCCCCCCCCCCCCCCCCCCCCC';

beforeEach(() => {
	__setTokenForTesting(TEST_TOKEN);
});

afterEach(() => {
	__setTokenForTesting(null);
});

function callGet(ip: string): Promise<Response> {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const event: any = {
		getClientAddress: () => ip,
		request: new Request('http://127.0.0.1:5179/api/token'),
		url: new URL('http://127.0.0.1:5179/api/token')
	};
	return Promise.resolve(GET(event));
}

test('GET from 127.0.0.1 → 200 + token body', async () => {
	const res = await callGet('127.0.0.1');
	expect(res.status).toBe(200);
	const body = await res.text();
	expect(body).toBe(TEST_TOKEN);
});

test('GET from ::1 → 200 + token body', async () => {
	const res = await callGet('::1');
	expect(res.status).toBe(200);
	const body = await res.text();
	expect(body).toBe(TEST_TOKEN);
});

test('GET from ::ffff:127.0.0.1 (IPv4-mapped IPv6) → 200 (normalized to loopback)', async () => {
	const res = await callGet('::ffff:127.0.0.1');
	expect(res.status).toBe(200);
	const body = await res.text();
	expect(body).toBe(TEST_TOKEN);
});

test('GET from 192.168.1.50 → 403', async () => {
	const res = await callGet('192.168.1.50');
	expect(res.status).toBe(403);
});

test('GET from 10.0.0.1 → 403 (RFC1918 is not loopback)', async () => {
	const res = await callGet('10.0.0.1');
	expect(res.status).toBe(403);
});

test('200 response sets cache-control: no-store', async () => {
	const res = await callGet('127.0.0.1');
	expect(res.headers.get('cache-control')).toBe('no-store');
});

test('200 response sets content-type text/plain; charset=utf-8', async () => {
	const res = await callGet('127.0.0.1');
	expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
});
