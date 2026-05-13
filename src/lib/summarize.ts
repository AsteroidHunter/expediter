import Anthropic from '@anthropic-ai/sdk';

const SYSTEM_PROMPT = `Read the assistant's latest message. Produce a 3-7 word caveman-style title for a developer notification. Telegraphic, compressed, maximally informative. End with ? if the assistant is asking a question or requesting approval. No punctuation otherwise. Examples: "approve git push?", "pick test framework?", "tests passed", "destructive delete confirm?". Output only the title, nothing else.`;

let _client: Anthropic | null = null;

function getClient(): Anthropic {
	if (_client) return _client;
	if (!process.env.ANTHROPIC_API_KEY) {
		throw new Error('ANTHROPIC_API_KEY not set');
	}
	_client = new Anthropic();
	return _client;
}

export async function summarize(latestMessage: string): Promise<string> {
	const client = getClient();
	const result = await client.messages.create({
		model: 'claude-haiku-4-5-20251001',
		max_tokens: 50,
		system: SYSTEM_PROMPT,
		messages: [{ role: 'user', content: latestMessage }]
	});
	const text = result.content
		.filter((b): b is Anthropic.TextBlock => b.type === 'text')
		.map((b) => b.text)
		.join('')
		.trim()
		.replace(/^["']|["']$/g, '')
		.trim();
	return text || '(no title)';
}
