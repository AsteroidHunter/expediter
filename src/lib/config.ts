import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_REFRESH_EVERY = 5;
const DEFAULT_CONFIG_PATH = join(homedir(), '.expediter', 'config.json');

export type TitleSource = 'chat-title' | 'haiku';
const DEFAULT_TITLE_SOURCE: TitleSource = 'chat-title';

// Read fresh on every call. The file is tiny and the call rate is one read per
// UserPromptSubmit hook — microseconds. Skipping caching means a future
// settings UI writing the file is picked up on the very next hook event with
// no invalidation dance. `configPath` is injectable for tests.
export function getRefreshInterval(configPath: string = DEFAULT_CONFIG_PATH): number {
	let raw: string;
	try {
		raw = readFileSync(configPath, 'utf8');
	} catch {
		return DEFAULT_REFRESH_EVERY;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return DEFAULT_REFRESH_EVERY;
	}

	if (!parsed || typeof parsed !== 'object') return DEFAULT_REFRESH_EVERY;
	const value = (parsed as { title_refresh_every?: unknown }).title_refresh_every;
	if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
		return DEFAULT_REFRESH_EVERY;
	}
	return value;
}

export function getTitleSource(configPath: string = DEFAULT_CONFIG_PATH): TitleSource {
	let raw: string;
	try {
		raw = readFileSync(configPath, 'utf8');
	} catch {
		return DEFAULT_TITLE_SOURCE;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return DEFAULT_TITLE_SOURCE;
	}

	if (!parsed || typeof parsed !== 'object') return DEFAULT_TITLE_SOURCE;
	const value = (parsed as { title_source?: unknown }).title_source;
	if (value === 'chat-title' || value === 'haiku') return value;
	return DEFAULT_TITLE_SOURCE;
}
