import { randomBytes } from 'node:crypto';

// In-memory per-process token. Minted on first read, held for the life of the
// daemon process. Stopping the daemon dies with the token; restarting mints a
// fresh one. No on-disk artifact — see plans/token-qr-fragment-auth for why.
let cached: string | null = null;

export function getServerToken(): string {
	if (cached === null) {
		cached = randomBytes(16).toString('base64url');
	}
	return cached;
}

// Test seam. Pass a string to inject a known value; pass null to clear the
// cache so the next getServerToken() call mints fresh. Used by hooks.server
// tests to exercise the gate against a known token, and by lib/token tests
// to verify the cache-and-mint behaviour without process restart.
export function __setTokenForTesting(value: string | null): void {
	cached = value;
}
