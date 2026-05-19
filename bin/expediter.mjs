#!/usr/bin/env bun
// expediter — start (or detect) the daemon, then print the tether URL + QR.
//
// Run from anywhere via the ~/.local/bin/expediter shim installed by install.sh.
// The shim sets EXPEDITER_HOME to the cloned-repo path, which is where this
// script and the SvelteKit build at $EXPEDITER_HOME/build/index.js live.

import os from 'node:os';
import { spawn } from 'node:child_process';
import qrcode from 'qrcode-terminal';

const PORT = process.env.EXPEDITER_PORT ?? '5179';
const HOME = process.env.EXPEDITER_HOME;

if (!HOME) {
	console.error('expediter: EXPEDITER_HOME is not set. Re-run install.sh from the cloned repo.');
	process.exit(1);
}

// --- pick the URL the phone should hit ---
// Mirror bin/tether-ip.mjs: rank candidates so iOS USB hotspot comes first,
// then iOS 17+ USB tether, Android tether, LAN, link-local. The phone has to
// reach the daemon over the tether interface for the origin gate to pass.
function score(addr) {
	if (addr.startsWith('172.20.10.')) return 0;
	if (addr.startsWith('192.0.0.')) return 1;
	if (addr.startsWith('192.168.42.')) return 2;
	if (addr.startsWith('192.168.')) return 3;
	if (addr.startsWith('10.')) return 3;
	if (addr.startsWith('169.254.')) return 4;
	return 5;
}

function pickTetherAddress() {
	const ifaces = os.networkInterfaces();
	const candidates = [];
	for (const addrs of Object.values(ifaces)) {
		if (!addrs) continue;
		for (const a of addrs) {
			if (a.family !== 'IPv4' || a.internal) continue;
			candidates.push(a.address);
		}
	}
	if (candidates.length === 0) return null;
	candidates.sort((a, b) => score(a) - score(b));
	return candidates[0];
}

// --- check whether the daemon is already serving ---
async function isDaemonUp() {
	try {
		const res = await fetch(`http://127.0.0.1:${PORT}/`, {
			signal: AbortSignal.timeout(750)
		});
		return res.status < 500;
	} catch {
		return false;
	}
}

async function waitForDaemon(timeoutMs = 15_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await isDaemonUp()) return true;
		await new Promise((r) => setTimeout(r, 250));
	}
	return false;
}

function printAccess() {
	const addr = pickTetherAddress();
	if (!addr) {
		console.log('');
		console.log(`Daemon running at http://localhost:${PORT}/`);
		console.log('');
		console.log('No tether interface detected. Plug your phone in with USB Personal Hotspot');
		console.log('on, then re-run `expediter` to get the URL + QR code.');
		return;
	}
	const url = `http://${addr}:${PORT}/`;
	console.log('');
	console.log(`  ${url}`);
	console.log('');
	qrcode.generate(url, { small: true });
}

// --- main ---
if (await isDaemonUp()) {
	printAccess();
	process.exit(0);
}

// Start the SvelteKit/adapter-node server in the foreground. Inherit stdio so
// the user sees its logs and Ctrl-C terminates it cleanly.
console.log('Starting Expediter daemon...');
const child = spawn('bun', [`${HOME}/build/index.js`], {
	stdio: ['ignore', 'inherit', 'inherit'],
	env: { ...process.env, PORT, HOST: '0.0.0.0' }
});

child.on('exit', (code) => process.exit(code ?? 0));
process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));

if (await waitForDaemon()) {
	printAccess();
} else {
	console.error('expediter: daemon did not come up within 15s; check the logs above.');
}
