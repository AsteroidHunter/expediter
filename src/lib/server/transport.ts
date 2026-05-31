// Pure transport-selection + URL helpers for the launcher (bin/expediter.mjs).
// Extracted so they can be unit-tested without importing the launcher itself,
// which starts the daemon as a side effect of being imported.

export type Transport = 'http' | 'https';

/**
 * Decide which transport to use. An explicit flag wins and should be persisted
 * (sticky preference); otherwise fall back to the saved preference, defaulting
 * to HTTPS. Throws on conflicting flags so the caller can print a usage error.
 */
export function resolveTransport(opts: {
	httpFlag?: boolean;
	httpsFlag?: boolean;
	saved?: string;
}): { transport: Transport; persist: boolean } {
	if (opts.httpFlag && opts.httpsFlag) {
		throw new Error('pass only one of --http / --https');
	}
	if (opts.httpFlag) return { transport: 'http', persist: true };
	if (opts.httpsFlag) return { transport: 'https', persist: true };
	return { transport: opts.saved === 'http' ? 'http' : 'https', persist: false };
}

/**
 * The URL the phone scans, token in the fragment. HTTPS is served on the stable
 * `<host>.local` mDNS name (the leaf cert's SAN, stable across DHCP changes);
 * HTTP uses the raw LAN IP. Returns null only for HTTP with no LAN address, so
 * the caller can print the "no interface" guidance.
 */
export function accessUrl(opts: {
	transport: Transport;
	dotLocalHost: string;
	lanIp?: string | null;
	port: string | number;
	token: string;
}): string | null {
	if (opts.transport === 'https') {
		return `https://${opts.dotLocalHost}:${opts.port}/#${opts.token}`;
	}
	if (!opts.lanIp) return null;
	return `http://${opts.lanIp}:${opts.port}/#${opts.token}`;
}
