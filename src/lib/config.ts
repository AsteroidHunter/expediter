import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_REFRESH_EVERY = 5;
const CONFIG_PATH = join(homedir(), '.expediter', 'config.json');

// Read fresh on every call. The file is tiny and the call rate is one read per
// UserPromptSubmit hook — microseconds. Skipping caching means a future
// settings UI writing the file is picked up on the very next hook event with
// no invalidation dance.
export function getRefreshInterval(): number {
	let raw: string;
	try {
		raw = readFileSync(CONFIG_PATH, 'utf8');
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
