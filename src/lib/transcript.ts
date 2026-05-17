import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

type TextBlock = { type: 'text'; text: string };
type ContentBlock = TextBlock | { type: 'thinking' } | { type: 'tool_use' } | { type: string };

type TranscriptLine = {
	type?: string;
	// User messages often carry a plain string here; assistant messages carry
	// the structured content-block array.
	message?: { content?: ContentBlock[] | string };
};

function isTextBlock(b: ContentBlock): b is TextBlock {
	return b.type === 'text' && typeof (b as TextBlock).text === 'string';
}

// Containment root for transcript_path. Defense-in-depth against a request body
// supplying e.g. /etc/passwd or ~/.ssh/id_ed25519 and getting it forwarded to
// the Anthropic summarize call. The gate in src/hooks.server.ts is the primary
// shield; this is the fallback if the gate is ever loosened or bypassed.
// Hard-coded because adapter-node refuses to start if any non-allowlisted
// EXPEDITER_* env var is set (build/env.js validates the prefix strictly).
const TRANSCRIPT_ROOT = path.resolve(path.join(os.homedir(), '.claude'));

function extractText(parsed: TranscriptLine): string {
	const content = parsed.message?.content;
	if (typeof content === 'string') return content.trim();
	if (Array.isArray(content)) {
		return content
			.filter(isTextBlock)
			.map((b) => b.text)
			.join('')
			.trim();
	}
	return '';
}

// Returns up to ~maxChars of the most recent user/assistant turns formatted as
// a chat transcript ("User: ...\n\nAssistant: ..."). Eliminates the previous
// race condition where reading only assistant text on a fresh Stop event would
// return null because the assistant message hadn't been flushed yet — user
// messages are always in the transcript by the time any hook fires.
export async function recentTranscriptText(
	transcriptPath: string,
	maxChars = 2000
): Promise<string | null> {
	// const t0 = Date.now();
	// const log = (msg: string): void => {
	// 	console.log(`[trace:transcript T+${Date.now() - t0}ms] ${msg}`);
	// };
	const resolved = path.resolve(transcriptPath);
	if (resolved !== TRANSCRIPT_ROOT && !resolved.startsWith(TRANSCRIPT_ROOT + path.sep)) {
		console.warn(`[transcript] rejected path outside root: ${resolved}`);
		return null;
	}

	// log(`readFile start: ${resolved}`);
	let raw: string;
	try {
		raw = await readFile(resolved, 'utf8');
	} catch {
		// log(`readFile failed: ${e}`);
		return null;
	}
	// log(`readFile done; bytes=${raw.length}`);
	const lines = raw.split('\n');
	// log(`split done; lines=${lines.length}`);

	const entries: string[] = [];
	let total = 0;
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i];
		if (!line) continue;
		let parsed: TranscriptLine;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}
		if (parsed.type !== 'user' && parsed.type !== 'assistant') continue;
		const text = extractText(parsed);
		if (!text) continue;
		const formatted = `${parsed.type === 'user' ? 'User' : 'Assistant'}: ${text}`;
		entries.unshift(formatted);
		total += formatted.length + 2; // +2 for the joining "\n\n"
		if (total >= maxChars) break;
	}

	if (entries.length === 0) return null;
	const joined = entries.join('\n\n');
	return joined.length > maxChars ? joined.slice(joined.length - maxChars) : joined;
}
