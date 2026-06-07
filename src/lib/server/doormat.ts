// The HTTP "doormat": a minimal plaintext listener that runs alongside the HTTPS
// app in HTTPS mode. Its only job is to bootstrap certificate trust on a new
// phone, so it serves exactly two things — the public CA certificate and a
// static setup page — and 404s everything else. It never touches the SvelteKit
// handler, so no app content, /api route, or data is ever reachable over
// plaintext. The CA cert is public material (private keys never leave the Mac),
// and the auth token rides in the URL fragment, which browsers never send to a
// server, so the doormat never sees a secret.

import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';

export type DoormatRoute = { kind: 'setup' } | { kind: 'ca' } | { kind: 'notfound' };

/**
 * Pure routing decision for the doormat. Only GET/HEAD to `/`, `/setup`, or
 * `/ca.crt` resolve; everything else (including any `/api/*` or app path, or the
 * private `/ca.key`) is a 404. Kept separate from the I/O so it can be
 * unit-tested exhaustively.
 */
export function routeDoormat(method: string, pathname: string): DoormatRoute {
	if (method !== 'GET' && method !== 'HEAD') return { kind: 'notfound' };
	if (pathname === '/' || pathname === '/setup') return { kind: 'setup' };
	if (pathname === '/ca.crt') return { kind: 'ca' };
	return { kind: 'notfound' };
}

/**
 * Build the doormat request handler. `setupHtml` is the raw setup page; any
 * `__HTTPS_PORT__` placeholder is filled with the real HTTPS port so the page
 * knows where to send the phone after the cert is trusted. `caCertPath` is read
 * fresh per request so a cert regenerated mid-session is still served correctly.
 */
export function createDoormatHandler(opts: {
	caCertPath: string;
	setupHtml: string;
	httpsPort: number;
}): (req: IncomingMessage, res: ServerResponse) => void {
	const page = opts.setupHtml.replaceAll('__HTTPS_PORT__', String(opts.httpsPort));
	return (req, res) => {
		// Parse only to normalize the path (collapses `/setup/../api` to `/api`);
		// the path is never used to read a file, so there is no traversal surface —
		// the route just selects one of three fixed responses.
		const pathname = new URL(req.url ?? '/', 'http://doormat').pathname;
		const route = routeDoormat(req.method ?? 'GET', pathname);
		const isHead = req.method === 'HEAD';

		if (route.kind === 'setup') {
			res.writeHead(200, {
				'content-type': 'text/html; charset=utf-8',
				'x-frame-options': 'DENY'
			});
			res.end(isHead ? undefined : page);
			return;
		}

		if (route.kind === 'ca') {
			let ca: Buffer;
			try {
				ca = readFileSync(opts.caCertPath);
			} catch {
				res.writeHead(503, { 'content-type': 'text/plain' });
				res.end(isHead ? undefined : 'certificate not ready');
				return;
			}
			// application/x-x509-ca-cert is what makes iOS Safari offer to install the
			// profile. Served inline (no attachment disposition) so the install flow
			// fires rather than a plain download.
			res.writeHead(200, { 'content-type': 'application/x-x509-ca-cert' });
			res.end(isHead ? undefined : ca);
			return;
		}

		res.writeHead(404, { 'content-type': 'text/plain' });
		res.end(isHead ? undefined : 'not found');
	};
}
