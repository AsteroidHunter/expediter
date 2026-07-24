import { json, type RequestHandler } from '@sveltejs/kit';
import { registerPoll } from '$lib/server/remoteTap';

// Long-poll endpoint for devbox helpers (D16). Loopback-trusted at the gate
// (hooks.server.ts): the request arrives through the reverse tunnel, whose
// devbox end is a user-private unix socket — file permission is the auth
// (D17), so no token rides in the request. The helper identifies its box by
// its ssh host PUBLIC keys ("keytype base64" lines from
// /etc/ssh/ssh_host_*.pub); taps are delivered only to a poll whose keys
// match the tapped ticket's box.

// A box has a handful of host keys; anything past this is not a helper.
const MAX_KEYS = 16;
// ssh-rsa public blobs run ~550 base64 chars; 4k is comfortably past any
// real key and small enough to keep a junk payload cheap.
const MAX_KEY_LEN = 4096;

// One warning per daemon lifetime: a helper that reports no keys can never
// receive a tap, and the cause (unreadable /etc/ssh/*.pub) needs an operator.
let warnedKeyless = false;

export const POST: RequestHandler = async ({ request }) => {
	let body: { host_keys?: unknown };
	try {
		body = (await request.json()) as { host_keys?: unknown };
	} catch {
		return json({ ok: false, error: 'invalid json' }, { status: 400 });
	}

	const raw = Array.isArray(body.host_keys) ? body.host_keys : [];
	const keys = raw
		.filter((k): k is string => typeof k === 'string' && k.length > 0 && k.length <= MAX_KEY_LEN)
		.slice(0, MAX_KEYS);

	if (keys.length === 0) {
		if (!warnedKeyless) {
			warnedKeyless = true;
			console.warn(
				'[remote-tap] a devbox helper polled without host keys (unreadable /etc/ssh/*.pub?) — taps can never reach that box'
			);
		}
		return json({ ok: false, error: 'no host keys reported' }, { status: 422 });
	}

	const answer = await registerPoll(keys);
	return json(answer);
};
