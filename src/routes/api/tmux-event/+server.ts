import { json, type RequestHandler } from '@sveltejs/kit';
import { reconcile } from '$lib/server/bootScan';

// Pinged by bin/expediter-tmux-hook.sh on tmux client-attached / client-detached
// (the daemon wires those hooks at boot). Loopback-trusted at the gate, like
// /api/hooks/event — the bridge runs on the daemon's host, so no token.
//
// The request carries NO payload: tmux's per-client hook events are version-
// quirky, so instead of trusting the event we run a LIGHT reconcile that re-reads
// tmux truth and flips attach flags on existing tickets (no seeding, no GC —
// a client attach/detach never creates or kills a pane). Awaited so the response
// only returns once flags are updated; reconcile swallows its own tmux errors,
// so this never rejects and the bridge always sees a 200.
export const POST: RequestHandler = async () => {
	try {
		await reconcile(undefined, 'light');
	} catch (err) {
		console.warn('[tmux-event] reconcile failed', err);
	}
	return json({ ok: true });
};
