import { spawn } from 'node:child_process';

const SYSTEM_PROMPT = `Read the assistant's latest message. Produce a 3-7 word caveman-style title for a developer notification. Telegraphic, compressed, maximally informative. End with ? if the assistant is asking a question or requesting approval. No punctuation otherwise. Examples: "approve git push?", "pick test framework?", "tests passed", "destructive delete confirm?". Output only the title, nothing else.`;

const SPAWN_TIMEOUT_MS = 10_000;

// Trim the last assistant message to a tail of `maxChars` so we don't ship a
// multi-thousand-token blob into claude for a one-line summary. Falls to the
// next newline so the model sees clean lines, not a partial first line.
function tailTruncate(text: string, maxChars = 400): string {
	if (text.length <= maxChars) return text;
	const tail = text.slice(text.length - maxChars);
	const firstNewline = tail.indexOf('\n');
	return firstNewline >= 0 ? tail.slice(firstNewline + 1) : tail;
}

export async function summarize(latestMessage: string): Promise<string | null> {
	const message = tailTruncate(latestMessage);

	return new Promise<string | null>((resolve) => {
		let settled = false;
		const finish = (result: string | null): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			resolve(result);
		};

		const proc = spawn(
			'claude',
			[
				'-p',
				SYSTEM_PROMPT,
				'--model',
				'haiku',
				'--output-format',
				'text',
				'--no-session-persistence'
			],
			{ stdio: ['pipe', 'pipe', 'pipe'] }
		);

		const timeout = setTimeout(() => {
			proc.kill();
			console.warn('[summarize] claude -p timed out after 10s');
			finish(null);
		}, SPAWN_TIMEOUT_MS);

		let stdout = '';
		let stderr = '';

		proc.stdout?.on('data', (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		proc.stderr?.on('data', (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		proc.on('error', (err) => {
			console.warn('[summarize] spawn error:', err.message);
			finish(null);
		});
		proc.on('exit', (code) => {
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

		proc.stdin?.write(message);
		proc.stdin?.end();
	});
}
