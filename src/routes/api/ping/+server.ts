import type { RequestHandler } from '@sveltejs/kit';

// Token-gated no-op probe. Reaches this handler only if hooks.server.ts's
// token check passed, so a 200 means the caller's token is currently valid.
// The phone uses this to distinguish "SSE dropped because the token died"
// (probe returns 403, caller clears sessionStorage and prompts re-scan) from
// "SSE dropped because of a network blip" (probe returns 200 or errors —
// EventSource's own retry handles it).
export const GET: RequestHandler = () => {
	return new Response(null, { status: 200, headers: { 'cache-control': 'no-store' } });
};
