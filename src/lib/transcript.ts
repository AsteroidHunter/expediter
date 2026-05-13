import { readFile } from 'node:fs/promises';

type TextBlock = { type: 'text'; text: string };
type ContentBlock = TextBlock | { type: 'thinking' } | { type: 'tool_use' } | { type: string };

type TranscriptLine = {
	type?: string;
	message?: { content?: ContentBlock[] };
};

function isTextBlock(b: ContentBlock): b is TextBlock {
	return b.type === 'text' && typeof (b as TextBlock).text === 'string';
}

export async function latestAssistantText(transcriptPath: string): Promise<string | null> {
	let raw: string;
	try {
		raw = await readFile(transcriptPath, 'utf8');
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
