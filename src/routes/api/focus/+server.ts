import { json, type RequestHandler } from '@sveltejs/kit';
import { focusPane, injectRemoteAttach, FocusError } from '$lib/tmux';
import { list, type Ticket } from '$lib/ticketStore';
import { dispatchTap, resolveTicketHostKeys, RemoteTapError } from '$lib/server/remoteTap';

// Gated on DEBUG_FOCUS so happy-path request/ok logs only run when diagnosing
// tap-to-focus locally. Error-path console.log calls below stay unconditional
// so failed taps are always visible.
const debugFocus = (msg: string): void => {
	if (process.env.DEBUG_FOCUS) console.log(msg);
};

// Remote-tmux flow (D16): the far window flip happens first and must be
// CONFIRMED by the devbox helper before anything local moves — a raised
// Terminal showing the wrong remote pane is a lie the user acts on. Box
// identity is resolved per tap (host keys via the ticket's live ssh
// connection), the tap travels the helper's long-poll channel, and a
// detached far session (OQ4/D15) additionally gets `tmux attach` typed into
// the local ssh pane, which the helper pre-positioned onto the tapped
// window.
async function focusRemoteTicket(ticket: Ticket): Promise<void> {
	const keys = await resolveTicketHostKeys(ticket.session_id);
	const result = await dispatchTap(keys, ticket.remote_pane!);
	if (!result.ok) {
		throw new RemoteTapError(result.error || 'devbox helper reported a failed window flip');
	}
	if (result.session_attached === false) {
		if (!result.session_name) {
			throw new RemoteTapError('far tmux is detached and the helper sent no session name');
		}
		await injectRemoteAttach(ticket.tmux_pane, result.session_name);
	}
	await focusPane(ticket.tmux_pane);
}

export const POST: RequestHandler = async ({ request }) => {
	let body: { pane?: string; session_id?: string };
	try {
		body = (await request.json()) as { pane?: string; session_id?: string };
	} catch {
		return json({ ok: false, error: 'invalid json' }, { status: 400 });
	}

	// Ticket-scoped resolution (D12): the phone sends {session_id} alone and
	// the daemon derives everything else from the ticket — a pane field would
	// only invite disagreement. A legacy {pane}-only body (stale cached PWA)
	// is honored exactly when it is unambiguous: one ticket on that pane.
	// Zero or several (remote-tmux siblings) → an error, never a guess.
	let ticket: Ticket | undefined;
	let label: string;
	if (body.session_id) {
		label = `session=${body.session_id.slice(0, 8)}`;
		ticket = list().find((t) => t.session_id === body.session_id);
		if (!ticket) {
			console.log(`[focus] unknown ${label}`);
			return json({ ok: false, error: 'no ticket for that session' }, { status: 410 });
		}
	} else if (body.pane) {
		label = `pane=${body.pane}`;
		const onPane = list().filter((t) => t.tmux_pane === body.pane);
		if (onPane.length === 0) {
			console.log(`[focus] legacy ${label}: no ticket`);
			return json({ ok: false, error: 'no ticket on that pane' }, { status: 410 });
		}
		if (onPane.length > 1) {
			console.log(`[focus] legacy ${label}: ${onPane.length} tickets — refusing to guess`);
			return json(
				{ ok: false, error: 'several tickets share that pane — update the app and retap' },
				{ status: 409 }
			);
		}
		ticket = onPane[0];
	} else {
		return json({ ok: false, error: 'missing session_id' }, { status: 400 });
	}

	const t0 = Date.now();
	debugFocus(`[focus] req ${label} pane=${ticket.tmux_pane} remote_pane=${ticket.remote_pane ?? ''}`);
	try {
		if (ticket.remote_pane) {
			await focusRemoteTicket(ticket);
		} else {
			await focusPane(ticket.tmux_pane);
		}
		const dt = Date.now() - t0;
		debugFocus(`[focus] ok ${label} dt=${dt}ms`);
		return json({ ok: true });
	} catch (err) {
		const dt = Date.now() - t0;
		if (err instanceof FocusError || err instanceof RemoteTapError) {
			console.log(`[focus] ${err.name} ${label} dt=${dt}ms err=${err.message}`);
			return json({ ok: false, error: err.message }, { status: 410 });
		}
		const msg = err instanceof Error ? err.message : 'focus failed';
		console.log(`[focus] error ${label} dt=${dt}ms err=${msg}`);
		return json({ ok: false, error: msg }, { status: 500 });
	}
};
