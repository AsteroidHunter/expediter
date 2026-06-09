#!/usr/bin/env bun
// expediter-server — the daemon entry, run by the launcher (bin/expediter.mjs)
// in place of adapter-node's generated build/index.js.
//
// Why a custom entry: adapter-node's build/index.js hardcodes
// `http.createServer()`, so it can't serve TLS. But the adapter also emits a
// self-contained request handler at build/handler.js (a sequence of
// static → prerendered → SSR with a built-in 404), which works as a plain
// Node request listener. So we reuse that exact handler and just choose the
// socket: https.createServer for the default secure transport, http otherwise.
// build/index.js stays untouched and regenerates cleanly on rebuild.
//
// Transport is selected by argv, NOT an env var: build/env.js throws at import
// if it sees any EXPEDITER_* var outside its closed allowlist, so we cannot
// introduce EXPEDITER_TRANSPORT. We only read the allowlisted HOST / PORT /
// SHUTDOWN_TIMEOUT the launcher already sets.
//
//   bun expediter-server.mjs           → HTTPS (default)
//   bun expediter-server.mjs --http    → HTTP fallback (cert bootstrap / opt-out)

import http from 'node:http';
import https from 'node:https';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { handler } from '../build/handler.js';
import { ensureCerts, localIPv4s } from '../src/lib/server/cert.ts';
import { createDoormatHandler } from '../src/lib/server/doormat.ts';
import { attachVoiceSocket } from '../src/lib/server/voiceSocket.ts';

const useHttps = !process.argv.includes('--http');
const host = process.env.EXPEDITER_HOST || '0.0.0.0';
const port = parseInt(process.env.EXPEDITER_PORT || '5179', 10);
// Launcher sets this to 1 (second); adapter-node default is 30. Either way the
// launcher SIGKILLs ~500ms after SIGTERM because Bun doesn't release open SSE
// streams on close, so this is a best-effort upper bound, not the real path.
const shutdownTimeout = parseInt(process.env.EXPEDITER_SHUTDOWN_TIMEOUT || '30', 10);

let server;
let doormat;
if (useHttps) {
	// Idempotent: a no-op when the chain already exists, generates it on the spot
	// otherwise. The leaf SAN includes the current LAN/tether IPs (localIPv4s) so
	// the phone can reach the daemon by IP — the only address that resolves across
	// an iPhone hotspot. The leaf reissues if those IPs change; the CA (the trusted
	// part on the phone) is untouched, so trust persists.
	const paths = ensureCerts({ ips: localIPv4s() });
	server = https.createServer(
		{ key: readFileSync(paths.key), cert: readFileSync(paths.cert) },
		handler
	);

	// The HTTP doormat runs alongside HTTPS purely to bootstrap cert trust on a new
	// phone: it serves only the public CA cert and the static setup page, and 404s
	// everything else (it never sees the SvelteKit handler, so no app/api/data
	// crosses plaintext). Default port is app+1 (5180). The setup page ships in
	// static/ and is read relative to this file so the user can restyle it with no
	// rebuild and no EXPEDITER_HOME dependency (the launcher strips that var).
	const setupHtml = readFileSync(new URL('../static/setup.html', import.meta.url), 'utf8');
	doormat = http.createServer(
		createDoormatHandler({ caCertPath: paths.caCert, setupHtml, httpsPort: port })
	);
	doormat.listen(port + 1, host, () => {
		console.log(`Cert bootstrap (HTTP) on http://${host}:${port + 1}`);
	});
} else {
	server = http.createServer(handler);
}

// Attach the Baseten audio WebSocket to the app server's `upgrade` event (the
// doormat is plaintext cert-bootstrap only, so audio never rides it). adapter-node's
// handler can't speak WS, so this is server-level, not a route. Its own inline
// token check runs here because hooks.server.ts never sees an upgrade.
attachVoiceSocket(server);

server.listen(port, host, () => {
	const scheme = useHttps ? 'https' : 'http';
	console.log(`Listening on ${scheme}://${host}:${port}`);
});

// Graceful shutdown mirroring adapter-node's build/index.js. closeIdleConnections
// / closeAllConnections may be absent on Bun's node:http shim, so guard them.
let shuttingDown = false;
function shutdown() {
	if (shuttingDown) return;
	shuttingDown = true;
	try {
		doormat?.close();
	} catch {
		/* doormat only runs in https mode */
	}
	try {
		server.closeIdleConnections?.();
	} catch {
		/* not implemented on this runtime */
	}
	server.close(() => process.exit(0));
	setTimeout(() => {
		try {
			server.closeAllConnections?.();
		} catch {
			/* not implemented on this runtime */
		}
		process.exit(0);
	}, shutdownTimeout * 1000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
