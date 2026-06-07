// Local TLS material for the HTTPS transport.
//
// iOS will only trust a server certificate that chains to a CA the device has
// explicitly trusted — there is no Safari "accept this cert anyway" escape
// hatch (unlike Chrome/Firefox). So we generate a two-cert chain, exactly like
// mkcert does, but with the openssl that ships on every Mac (no extra
// dependency):
//
//   - a long-lived root CA  (ca.crt / ca.key)      ← installed + trusted on the phone, once
//   - a short-lived leaf    (cert.pem / key.pem)   ← what the daemon actually serves
//
// The leaf carries everything iOS 13+ requires (Apple support 103769):
//   - Subject Alternative Name with the DNS name (CN-only names are rejected)
//   - extendedKeyUsage = serverAuth
//   - a human-readable Common Name (without one the CA won't even appear in
//     Settings → General → About → Certificate Trust Settings)
//
// Private chains are exempt from Apple's 825-day cap, so the CA is long-lived
// (trust persists for years, no re-enrollment churn); the leaf still uses a
// conservative 825 days. The leaf's SAN covers the stable `<host>.local` mDNS
// name, loopback, AND the machine's current LAN/tether IPs: the phone reaches
// the daemon by IP (the only thing that resolves across an iPhone hotspot), so
// the cert must be valid for that IP. Adding volatile IPs is free — the phone
// trusts the long-lived CA, not the leaf, so reissuing the leaf when the IP
// changes never re-prompts for trust.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { homedir, hostname, networkInterfaces } from 'node:os';
import path from 'node:path';

export interface CertPaths {
	dir: string;
	/** Root CA certificate — this is the file that gets installed + trusted on the phone. */
	caCert: string;
	caKey: string;
	/** Leaf private key the daemon serves. */
	key: string;
	/** Leaf certificate + CA (fullchain) the daemon serves. */
	cert: string;
}

/** Default on-disk home for TLS material. Overridable for tests. */
export function certDir(base?: string): string {
	return base ?? path.join(homedir(), '.expediter', 'tls');
}

export function certPaths(base?: string): CertPaths {
	const dir = certDir(base);
	return {
		dir,
		caCert: path.join(dir, 'ca.crt'),
		caKey: path.join(dir, 'ca.key'),
		key: path.join(dir, 'key.pem'),
		cert: path.join(dir, 'cert.pem')
	};
}

/**
 * The mDNS `.local` hostname the phone reaches the daemon at. On macOS the
 * authoritative source is `scutil --get LocalHostName` (that's the name Bonjour
 * actually broadcasts); fall back to os.hostname() elsewhere. The launcher
 * imports this same helper so the QR URL and the cert SAN can never disagree.
 */
export function localDotLocalName(): string {
	let name = '';
	try {
		name = execFileSync('scutil', ['--get', 'LocalHostName'], { encoding: 'utf8' }).trim();
	} catch {
		// not macOS, or scutil unavailable
	}
	if (!name) {
		name = hostname()
			.replace(/\.local$/i, '')
			.split('.')[0];
	}
	return `${name}.local`;
}

function openssl(args: string[]): void {
	try {
		execFileSync('openssl', args, { stdio: 'pipe' });
	} catch (err) {
		const e = err as { stderr?: Buffer; message?: string };
		const detail = e.stderr?.toString().trim() || e.message || 'unknown error';
		throw new Error(`openssl ${args[0]} failed: ${detail}`);
	}
}

/** Generate the root CA if it is not already present. */
function ensureCa(p: CertPaths): void {
	if (existsSync(p.caKey) && existsSync(p.caCert)) return;
	openssl([
		'req',
		'-x509',
		'-newkey',
		'rsa:2048',
		'-nodes',
		'-keyout',
		p.caKey,
		'-out',
		p.caCert,
		'-days',
		'3650',
		'-subj',
		'/CN=Expediter Local CA/O=Expediter',
		'-addext',
		'basicConstraints=critical,CA:TRUE,pathlen:0',
		'-addext',
		'keyUsage=critical,keyCertSign,cRLSign'
	]);
}

/**
 * The SANs the leaf certificate covers: the `.local` hostname, loopback, and the
 * machine's current LAN/tether IPs. The IPs are what the phone actually connects
 * to (especially across a hotspot, where `.local` doesn't resolve), so they must
 * be present. The leaf is reissued whenever this set changes (a new network or
 * IP); that's cheap because trust lives at the CA, not the leaf.
 */
export function leafSans(host: string, ips: string[] = []): string[] {
	return [`DNS:${host}`, 'DNS:localhost', 'IP:127.0.0.1', 'IP:::1', ...ips.map((ip) => `IP:${ip}`)];
}

/**
 * Generate the leaf if it is missing or if the hostname it was issued for has
 * changed. Idempotent: a second call with the same host is a no-op. The SAN set
 * issued is recorded alongside the leaf so we can detect a hostname change
 * without parsing the certificate back out.
 */
function ensureLeaf(p: CertPaths, host: string, ips: string[]): void {
	const sans = leafSans(host, ips);
	const stamp = path.join(p.dir, 'leaf.sans');
	const current = existsSync(stamp) ? readFileSync(stamp, 'utf8').trim() : '';
	const want = sans.join(',');
	if (existsSync(p.key) && existsSync(p.cert) && current === want) return;

	const csr = path.join(p.dir, 'leaf.csr');
	const ext = path.join(p.dir, 'leaf.ext');
	const leafCert = path.join(p.dir, 'leaf.crt');

	openssl([
		'req',
		'-newkey',
		'rsa:2048',
		'-nodes',
		'-keyout',
		p.key,
		'-out',
		csr,
		'-subj',
		`/CN=Expediter (${host})/O=Expediter`
	]);

	writeFileSync(
		ext,
		[
			'basicConstraints=critical,CA:FALSE',
			'keyUsage=critical,digitalSignature,keyEncipherment',
			'extendedKeyUsage=serverAuth',
			`subjectAltName=${sans.join(',')}`,
			''
		].join('\n'),
		'utf8'
	);

	openssl([
		'x509',
		'-req',
		'-in',
		csr,
		'-CA',
		p.caCert,
		'-CAkey',
		p.caKey,
		'-CAcreateserial',
		'-out',
		leafCert,
		'-days',
		'825',
		'-sha256',
		'-extfile',
		ext
	]);

	// Serve a fullchain (leaf + CA) so clients that don't already hold the root
	// in the handshake still build the path; the phone trusts the CA directly,
	// but fullchain is harmless and more robust.
	const fullchain = readFileSync(leafCert, 'utf8').trimEnd() + '\n' + readFileSync(p.caCert, 'utf8');
	writeFileSync(p.cert, fullchain, 'utf8');
	writeFileSync(stamp, want, 'utf8');
}

/**
 * Ensure a CA + leaf exist on disk and return their paths. Generates whatever
 * is missing; safe to call on every daemon start. `host` defaults to the
 * machine's `.local` mDNS name; `ips` are extra IP SANs (the current LAN/tether
 * addresses) so the phone can reach the daemon by IP.
 */
export function ensureCerts(opts: { dir?: string; host?: string; ips?: string[] } = {}): CertPaths {
	const p = certPaths(opts.dir);
	mkdirSync(p.dir, { recursive: true, mode: 0o700 });
	ensureCa(p);
	ensureLeaf(p, opts.host ?? localDotLocalName(), opts.ips ?? []);
	return p;
}

/** True once a CA and a leaf are both on disk. */
export function certsExist(base?: string): boolean {
	const p = certPaths(base);
	return existsSync(p.caCert) && existsSync(p.key) && existsSync(p.cert);
}

/** mtime of the leaf cert, for tests asserting idempotency. */
export function leafMtimeMs(base?: string): number {
	return statSync(certPaths(base).cert).mtimeMs;
}

/**
 * The machine's current external (non-internal) IPv4 addresses, for the leaf
 * SAN, so the phone can reach the daemon by IP. VPN/tunnel interfaces are
 * skipped (same set as the launcher's address picker): a phone can never route
 * to a utun/ipsec/wg address, so there's no point covering it and it would only
 * churn the leaf when the tunnel reconnects.
 */
export function localIPv4s(): string[] {
	const out: string[] = [];
	for (const [name, addrs] of Object.entries(networkInterfaces())) {
		if (/^(utun|ipsec|ppp|tun|tap|wg)\d*$/i.test(name)) continue;
		for (const a of addrs ?? []) {
			if (a.family === 'IPv4' && !a.internal) out.push(a.address);
		}
	}
	return out;
}
