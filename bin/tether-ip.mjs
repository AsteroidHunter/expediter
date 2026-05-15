#!/usr/bin/env node
// tether-ip.mjs — prints likely-tether URLs the phone can hit over USB.
//
// iOS USB Personal Hotspot puts the Mac on the 172.20.10.x/28 subnet by
// default. We rank candidates so the most-likely-tether interface prints
// first, but every non-loopback IPv4 is listed so users on Bluetooth or
// other hotspot modes still see a working URL.

import os from 'node:os';

const PORT = process.env.EXPEDITER_PORT ?? '5179';

const ifaces = os.networkInterfaces();
const candidates = [];
for (const [name, addrs] of Object.entries(ifaces)) {
	if (!addrs) continue;
	for (const a of addrs) {
		if (a.family !== 'IPv4') continue;
		if (a.internal) continue;
		candidates.push({ name, address: a.address });
	}
}

function score(c) {
	// 0 = iOS USB hotspot, 1 = bluetooth hotspot, 2 = LAN, 3 = anything else
	if (c.address.startsWith('172.20.10.')) return 0;
	if (c.address.startsWith('169.254.')) return 1; // link-local fallback
	if (c.address.startsWith('192.168.')) return 2;
	if (c.address.startsWith('10.')) return 2;
	return 3;
}

candidates.sort((a, b) => score(a) - score(b));

if (candidates.length === 0) {
	console.error('no non-loopback IPv4 interfaces — is the phone plugged in with USB Personal Hotspot on?');
	process.exit(1);
}

for (const c of candidates) {
	const hint = score(c) === 0 ? ' ← likely tether' : '';
	console.log(`http://${c.address}:${PORT}/  (${c.name})${hint}`);
}
