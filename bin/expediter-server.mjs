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
import { ensureCerts } from '../src/lib/server/cert.ts';

const useHttps = !process.argv.includes('--http');
const host = process.env.EXPEDITER_HOST || '0.0.0.0';
const port = parseInt(process.env.EXPEDITER_PORT || '5179', 10);
// Launcher sets this to 1 (second); adapter-node default is 30. Either way the
// launcher SIGKILLs ~500ms after SIGTERM because Bun doesn't release open SSE
// streams on close, so this is a best-effort upper bound, not the real path.
const shutdownTimeout = parseInt(process.env.EXPEDITER_SHUTDOWN_TIMEOUT || '30', 10);

let server;
if (useHttps) {
	// Idempotent: a no-op when install.sh already generated the chain, generates
	// it on the spot if the user flipped to HTTPS after install. The leaf is keyed
	// to the stable <host>.local mDNS name, so this never churns on IP changes.
	const { key, cert } = ensureCerts();
	server = https.createServer({ key: readFileSync(key), cert: readFileSync(cert) }, handler);
} else {
	server = http.createServer(handler);
}

server.listen(port, host, () => {
	const scheme = useHttps ? 'https' : 'http';
	console.log(`Listening on ${scheme}://${host}:${port}`);
	// DEBUG_EXPEDITER (not EXPEDITER_*, which build/env.js would reject): confirm
	// the socket actually bound where we think, and on which address family. A
	// phone reaching this Mac over IPv6-only Wi-Fi won't hit an IPv4 0.0.0.0 bind.
	if (process.env.DEBUG_EXPEDITER) {
		const addr = server.address();
		console.error(
			`[expediter:debug] bound socket: ${JSON.stringify(addr)} useHttps=${useHttps}`
		);
	}
});

// Graceful shutdown mirroring adapter-node's build/index.js. closeIdleConnections
// / closeAllConnections may be absent on Bun's node:http shim, so guard them.
let shuttingDown = false;
function shutdown() {
	if (shuttingDown) return;
	shuttingDown = true;
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
