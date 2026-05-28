import { json, type RequestHandler } from '@sveltejs/kit';

// Token-gated daemon shutdown. The gate in hooks.server.ts has already verified
// the caller's token, so reaching this handler means a phone-side action (or a
// token-bearing local client). Schedule process.exit shortly after the response
// flushes — the launcher's child.on('exit') in bin/expediter.mjs propagates and
// terminates the parent shim too. setTimeout is .unref()'d so it never blocks
// process exit on its own; the real exit comes from the explicit call inside.
export const POST: RequestHandler = () => {
	console.log('[shutdown] requested via /api/shutdown');
	setTimeout(() => process.exit(0), 100).unref();
	return json({ ok: true });
};
