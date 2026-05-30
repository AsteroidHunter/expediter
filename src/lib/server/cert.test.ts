import { test, expect, beforeEach, afterEach } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ensureCerts, certPaths, leafSans, certsExist, leafMtimeMs, localDotLocalName } from './cert';

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(path.join(tmpdir(), 'expediter-cert-'));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

/** Decode a PEM cert to its openssl -text dump for assertions. */
function dump(file: string): string {
	return execFileSync('openssl', ['x509', '-in', file, '-text', '-noout'], { encoding: 'utf8' });
}

test('ensureCerts writes a CA + leaf + key', () => {
	const p = ensureCerts({ dir, host: 'as-machine.local' });
	expect(existsSync(p.caCert)).toBe(true);
	expect(existsSync(p.caKey)).toBe(true);
	expect(existsSync(p.key)).toBe(true);
	expect(existsSync(p.cert)).toBe(true);
	expect(certsExist(dir)).toBe(true);
});

test('CA is a real CA (basicConstraints CA:TRUE)', () => {
	const p = ensureCerts({ dir, host: 'as-machine.local' });
	const ca = dump(p.caCert);
	expect(ca).toContain('CA:TRUE');
});

test('leaf carries the SAN, serverAuth EKU, and a human-readable CN', () => {
	const p = ensureCerts({ dir, host: 'as-machine.local' });
	const leaf = dump(p.cert); // cert.pem is fullchain; -text reads the leaf (first cert)
	// SAN with the DNS name — iOS rejects CN-only names
	expect(leaf).toContain('DNS:as-machine.local');
	expect(leaf).toContain('DNS:localhost');
	expect(leaf).toContain('127.0.0.1');
	// EKU serverAuth — iOS requires it
	expect(leaf).toContain('TLS Web Server Authentication');
	// human-readable CN — without it the cert won't show in the trust toggle
	expect(leaf).toContain('CN=Expediter (as-machine.local)');
});

test('cert.pem is a fullchain (leaf + CA = two certificates)', () => {
	const p = ensureCerts({ dir, host: 'as-machine.local' });
	const pem = execFileSync('cat', [p.cert], { encoding: 'utf8' });
	const count = (pem.match(/BEGIN CERTIFICATE/g) || []).length;
	expect(count).toBe(2);
});

test('second call with the same host is a no-op (idempotent)', () => {
	ensureCerts({ dir, host: 'as-machine.local' });
	const first = leafMtimeMs(dir);
	ensureCerts({ dir, host: 'as-machine.local' });
	const second = leafMtimeMs(dir);
	expect(second).toBe(first);
});

test('changing the host regenerates the leaf for the new name', () => {
	ensureCerts({ dir, host: 'old-name.local' });
	expect(dump(certPaths(dir).cert)).toContain('DNS:old-name.local');

	ensureCerts({ dir, host: 'new-name.local' });
	const leaf = dump(certPaths(dir).cert);
	expect(leaf).toContain('DNS:new-name.local');
	expect(leaf).not.toContain('DNS:old-name.local');
});

test('the CA is reused across a hostname change (only the leaf is reissued)', () => {
	const p1 = ensureCerts({ dir, host: 'old-name.local' });
	const caBefore = execFileSync('openssl', ['x509', '-in', p1.caCert, '-serial', '-noout'], {
		encoding: 'utf8'
	});
	ensureCerts({ dir, host: 'new-name.local' });
	const caAfter = execFileSync('openssl', ['x509', '-in', p1.caCert, '-serial', '-noout'], {
		encoding: 'utf8'
	});
	// Same CA serial → the installed-and-trusted root on the phone stays valid.
	expect(caAfter).toBe(caBefore);
});

test('leafSans is stable (no LAN IP, so DHCP changes never force a reissue)', () => {
	const sans = leafSans('as-machine.local');
	expect(sans).toEqual(['DNS:as-machine.local', 'DNS:localhost', 'IP:127.0.0.1', 'IP:::1']);
});

test('localDotLocalName ends in .local', () => {
	expect(localDotLocalName().endsWith('.local')).toBe(true);
});
