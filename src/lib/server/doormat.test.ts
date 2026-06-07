import { test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { routeDoormat, createDoormatHandler } from './doormat';

test('GET / and /setup route to the setup page', () => {
	expect(routeDoormat('GET', '/').kind).toBe('setup');
	expect(routeDoormat('GET', '/setup').kind).toBe('setup');
});

test('GET /ca.crt routes to the certificate', () => {
	expect(routeDoormat('GET', '/ca.crt').kind).toBe('ca');
});

test('HEAD is allowed so the setup page can probe', () => {
	expect(routeDoormat('HEAD', '/setup').kind).toBe('setup');
	expect(routeDoormat('HEAD', '/ca.crt').kind).toBe('ca');
});

test('the doormat never routes app, /api, or the private key', () => {
	for (const p of [
		'/api/token',
		'/api/stream',
		'/api/hooks/event',
		'/tickets',
		'/index.html',
		'/app.js',
		'/ca.key',
		'/favicon.ico'
	]) {
		expect(routeDoormat('GET', p).kind).toBe('notfound');
	}
});

test('non-GET/HEAD methods are rejected', () => {
	expect(routeDoormat('POST', '/ca.crt').kind).toBe('notfound');
	expect(routeDoormat('POST', '/setup').kind).toBe('notfound');
	expect(routeDoormat('PUT', '/').kind).toBe('notfound');
});

function fakeReqRes(method: string, url: string) {
	const req = { method, url } as unknown as import('node:http').IncomingMessage;
	const res = {
		statusCode: 0,
		headers: {} as Record<string, string>,
		body: undefined as unknown,
		ended: false,
		writeHead(code: number, hdrs?: Record<string, string>) {
			this.statusCode = code;
			this.headers = hdrs ?? {};
			return this;
		},
		end(b?: unknown) {
			this.body = b;
			this.ended = true;
		}
	};
	return { req, res: res as unknown as import('node:http').ServerResponse & typeof res };
}

test('handler serves the setup page with the HTTPS port substituted', () => {
	const dir = mkdtempSync(path.join(tmpdir(), 'doormat-'));
	try {
		const caPath = path.join(dir, 'ca.crt');
		writeFileSync(caPath, 'FAKE-CA');
		const handler = createDoormatHandler({
			caCertPath: caPath,
			setupHtml: '<p>connect to port __HTTPS_PORT__</p>',
			httpsPort: 5179
		});
		const { req, res } = fakeReqRes('GET', '/setup');
		handler(req, res);
		expect(res.statusCode).toBe(200);
		expect(res.headers['content-type']).toContain('text/html');
		expect(res.body).toBe('<p>connect to port 5179</p>');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('handler serves the CA cert with the iOS install MIME type', () => {
	const dir = mkdtempSync(path.join(tmpdir(), 'doormat-'));
	try {
		const caPath = path.join(dir, 'ca.crt');
		writeFileSync(caPath, 'FAKE-CA-BYTES');
		const handler = createDoormatHandler({ caCertPath: caPath, setupHtml: 'x', httpsPort: 5179 });
		const { req, res } = fakeReqRes('GET', '/ca.crt');
		handler(req, res);
		expect(res.statusCode).toBe(200);
		expect(res.headers['content-type']).toBe('application/x-x509-ca-cert');
		expect((res.body as Buffer).toString()).toBe('FAKE-CA-BYTES');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('handler 404s an /api path even with a query string', () => {
	const handler = createDoormatHandler({ caCertPath: '/nonexistent', setupHtml: 'x', httpsPort: 5179 });
	const { req, res } = fakeReqRes('GET', '/api/token?t=abc');
	handler(req, res);
	expect(res.statusCode).toBe(404);
});

test('handler normalizes path traversal back to a 404', () => {
	const handler = createDoormatHandler({ caCertPath: '/nonexistent', setupHtml: 'x', httpsPort: 5179 });
	const { req, res } = fakeReqRes('GET', '/setup/../api/token');
	handler(req, res);
	expect(res.statusCode).toBe(404);
});

test('handler 503s /ca.crt when the cert file is missing', () => {
	const handler = createDoormatHandler({ caCertPath: '/nonexistent/ca.crt', setupHtml: 'x', httpsPort: 5179 });
	const { req, res } = fakeReqRes('GET', '/ca.crt');
	handler(req, res);
	expect(res.statusCode).toBe(503);
});
