import type { RequestHandler } from './$types';
import { list, subscribe, type Ticket } from '$lib/ticketStore';

const encoder = new TextEncoder();

function frame(data: Ticket[]): Uint8Array {
	return encoder.encode(`data: ${JSON.stringify(data)}\n\n`);
}

function comment(text: string): Uint8Array {
	return encoder.encode(`: ${text}\n\n`);
}

export const GET: RequestHandler = async ({ request }) => {
	let unsub: (() => void) | null = null;
	let heartbeat: ReturnType<typeof setInterval> | null = null;
	let closed = false;

	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			const safeEnqueue = (chunk: Uint8Array) => {
				if (closed) return;
				try {
					controller.enqueue(chunk);
				} catch {
					closed = true;
				}
			};

			safeEnqueue(frame(list()));

			unsub = subscribe((snapshot) => safeEnqueue(frame(snapshot)));

			heartbeat = setInterval(() => safeEnqueue(comment('ping')), 20000);

			const onAbort = () => {
				if (closed) return;
				closed = true;
				if (heartbeat) clearInterval(heartbeat);
				if (unsub) unsub();
				try {
					controller.close();
				} catch {
					// already closed
				}
			};

			if (request.signal.aborted) onAbort();
			else request.signal.addEventListener('abort', onAbort);
		},
		cancel() {
			closed = true;
			if (heartbeat) clearInterval(heartbeat);
			if (unsub) unsub();
		}
	});

	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache, no-transform',
			Connection: 'keep-alive',
			'X-Accel-Buffering': 'no'
		}
	});
};
