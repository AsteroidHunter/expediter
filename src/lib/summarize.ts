import { spawn as nodeSpawn } from 'node:child_process';

// The chat snippet gets embedded in the prompt with triple-quote delimiters
// rather than piped via stdin. Stdin-piping causes claude -p (without --bare,
// which we can't use under subscription auth) to fall into agent-mode and reply
// conversationally — even with explicit instructions. Embedding the content
// in the prompt with clear delimiters gets reliable single-line titles.
const INSTRUCTION = `Summarize the topic of the following chat snippet between a user and an assistant in 3-7 words, caveman-style title for a developer notification. Focus on what's currently happening or being asked. End with ? if the last message is a question or requests approval. No punctuation otherwise. Examples: "approve git push?", "pick test framework?", "tests passed", "destructive delete confirm?". Output ONLY the title — no preamble, no clarifying questions, no quoting, nothing else.`;

const SPAWN_TIMEOUT_MS = 10_000;

// Trim the last assistant message to a tail of `maxChars` so we don't ship a
// multi-thousand-token blob into claude for a one-line summary. Falls to the
// next newline so the model sees clean lines, not a partial first line.
export function tailTruncate(text: string, maxChars = 400): string {
	if (text.length <= maxChars) return text;
	const tail = text.slice(text.length - maxChars);
	const firstNewline = tail.indexOf('\n');
	return firstNewline >= 0 ? tail.slice(firstNewline + 1) : tail;
}

export type SpawnFn = typeof nodeSpawn;

// let traceCounter = 0;

// `spawnFn` is injectable for tests; production callers use the default.
export async function summarize(
	latestMessage: string,
	spawnFn: SpawnFn = nodeSpawn
): Promise<string | null> {
	const message = tailTruncate(latestMessage);
	const prompt = `${INSTRUCTION}\n\nMessage:\n\n"""\n${message}\n"""`;
	// const traceId = ++traceCounter;
	// const t0 = Date.now();
	// const log = (msg: string): void => {
	// 	console.log(`[trace:summarize#${traceId} T+${Date.now() - t0}ms] ${msg}`);
	// };
	// log(
	// 	`enter; message_len=${latestMessage.length} truncated_len=${message.length} prompt_len=${prompt.length}`
	// );

	return new Promise<string | null>((resolve) => {
		let settled = false;
		// let firstByteAt: number | null = null;
		const finish = (result: string | null): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			// log(`finish; result=${result === null ? 'null' : `len=${result.length}`}`);
			resolve(result);
		};

		// log('spawning claude');
		const proc = spawnFn(
			'claude',
			[
				'-p',
				prompt,
				'--model',
				'haiku',
				'--output-format',
				'text',
				'--no-session-persistence'
			],
			// Clear TMUX_PANE so the subprocess's own hook firing bails at the
			// `[ -z "${TMUX_PANE:-}" ]` gate in expediter-hook.sh, instead of
			// looping UserPromptSubmit/Stop back to this server as a phantom
			// session with no transcript.
			{ stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TMUX_PANE: '' } }
		);
		// log(`spawned; pid=${proc.pid ?? 'unknown'}`);

		const timeout = setTimeout(() => {
			// log(`TIMEOUT firing kill; first_byte_at=${firstByteAt ?? 'never'}`);
			proc.kill();
			console.warn('[summarize] claude -p timed out after 10s');
			finish(null);
		}, SPAWN_TIMEOUT_MS);

		let stdout = '';
		let stderr = '';

		proc.stdout?.on('data', (chunk: Buffer) => {
			// if (firstByteAt === null) {
			// 	firstByteAt = Date.now() - t0;
			// 	log(`first stdout chunk; chunk_len=${chunk.length}`);
			// }
			stdout += chunk.toString();
		});
		proc.stderr?.on('data', (chunk: Buffer) => {
			stderr += chunk.toString();
			// log(`stderr chunk: ${chunk.toString().trim().slice(0, 200)}`);
		});
		proc.on('error', (err) => {
			// log(`spawn error: ${err.message}`);
			console.warn('[summarize] spawn error:', err.message);
			finish(null);
		});
		proc.on('exit', (code) => {
			// log(`exit code=${code}; stdout_len=${stdout.length} stderr_len=${stderr.length}`);
			if (code !== 0) {
				console.warn(`[summarize] claude exited ${code}: ${stderr.trim()}`);
				finish(null);
				return;
			}
			const cleaned = stdout
				.trim()
				.replace(/^["']|["']$/g, '')
				.trim();
			finish(cleaned || null);
		});

		// stdin is 'ignore' — the message is embedded in the prompt above, not
		// piped, so there's nothing to write here.
	});
}
