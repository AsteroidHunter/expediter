import type { RequestHandler } from '@sveltejs/kit';
import { getServerToken } from '$lib/token';
import { isAllowedIp, normalizeIp } from '../../../hooks.server';

// Returns the daemon's in-memory token. Loopback-only — the gate in
// hooks.server.ts intentionally defers to this handler without enforcing
// the token check (the caller can't provide a token before they have one),
// so the loopback restriction has to live here. Any non-loopback request
// gets the same 403 + null body as a missing-token rejection elsewhere.
export const GET: RequestHandler = ({ getClientAddress }) => {
	let ip: string | null = null;
	try {
		ip = normalizeIp(getClientAddress());
	} catch {
		ip = null;
	}
	if (!isAllowedIp(ip)) {
		return new Response(null, { status: 403 });
	}
	return new Response(getServerToken(), {
		headers: {
			'content-type': 'text/plain; charset=utf-8',
			'cache-control': 'no-store'
		}
	});
};
