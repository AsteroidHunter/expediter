import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

type TextBlock = { type: 'text'; text: string };
type ContentBlock = TextBlock | { type: 'thinking' } | { type: 'tool_use' } | { type: string };

type TranscriptLine = {
	type?: string;
	message?: { content?: ContentBlock[] };
};

function isTextBlock(b: ContentBlock): b is TextBlock {
	return b.type === 'text' && typeof (b as TextBlock).text === 'string';
}

// Containment root for transcript_path. Defense-in-depth against a request body
// supplying e.g. /etc/passwd or ~/.ssh/id_ed25519 and getting it forwarded to
// the Anthropic summarize call. The gate in src/hooks.server.ts is the primary
// shield; this is the fallback if the gate is ever loosened or bypassed.
const TRANSCRIPT_ROOT = path.resolve(
	process.env.EXPEDITER_TRANSCRIPT_ROOT ?? path.join(os.homedir(), '.claude')
);

export async function latestAssistantText(transcriptPath: string): Promise<string | null> {
	const resolved = path.resolve(transcriptPath);
	if (resolved !== TRANSCRIPT_ROOT && !resolved.startsWith(TRANSCRIPT_ROOT + path.sep)) {
		console.warn(`[transcript] rejected path outside root: ${resolved}`);
		return null;
	}

	let raw: string;
	try {
		raw = await readFile(resolved, 'utf8');
	} catch {
		return null;
	}
	const lines = raw.split('\n');
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i];
		if (!line) continue;
		let parsed: TranscriptLine;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}
		if (parsed.type !== 'assistant') continue;
		const blocks = parsed.message?.content;
		if (!Array.isArray(blocks)) continue;
		const text = blocks
			.filter(isTextBlock)
			.map((b) => b.text)
			.join('')
			.trim();
		if (text.length > 0) return text;
	}
	return null;
}
