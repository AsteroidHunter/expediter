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
 * The URL the phone scans, token in the fragment. Always an HTTP URL at the LAN
 * IP: in https mode it points at the cert-bootstrap doormat (app port + 1),
 * which serves the setup page and then forwards the phone to the HTTPS app; in
 * http mode it points at the app directly. Returns null when there's no LAN
 * address, so the caller can print the "no interface" guidance. The HTTPS app is
 * reached by IP (covered by the leaf SAN); `.local` lives in the cert only.
 */
export function accessUrl(opts: {
	transport: Transport;
	lanIp?: string | null;
	appPort: string | number;
	token: string;
}): string | null {
	if (!opts.lanIp) return null;
	const port = opts.transport === 'https' ? Number(opts.appPort) + 1 : opts.appPort;
	return `http://${opts.lanIp}:${port}/#${opts.token}`;
}
