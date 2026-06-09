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

export type SttBackend = 'baseten' | 'voice';
// Default to the built-in /voice backend: it needs no API key and no deployed
// model, so speech-to-prompt works out of the box on a Claude login. Baseten is
// the remote phone-mic path you opt into by setting baseten_model_id + the
// BASETEN_API_KEY env var and flipping this to "baseten". Failing safe toward the
// no-config backend keeps the feature from being broken-by-default when no key
// is set.
const DEFAULT_STT_BACKEND: SttBackend = 'voice';

export function getSttBackend(configPath: string = DEFAULT_CONFIG_PATH): SttBackend {
	let raw: string;
	try {
		raw = readFileSync(configPath, 'utf8');
	} catch {
		return DEFAULT_STT_BACKEND;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return DEFAULT_STT_BACKEND;
	}

	if (!parsed || typeof parsed !== 'object') return DEFAULT_STT_BACKEND;
	const value = (parsed as { stt_backend?: unknown }).stt_backend;
	if (value === 'baseten' || value === 'voice') return value;
	return DEFAULT_STT_BACKEND;
}

// The Baseten model/chain id that selects the streaming-STT deployment for the WS
// URL. No sensible default — it's unique to the user's Baseten account — so an
// unset/blank/non-string value returns null and the Baseten backend (Phase 4)
// surfaces a clear "not configured" error instead of guessing.
export function getBasetenModelId(configPath: string = DEFAULT_CONFIG_PATH): string | null {
	let raw: string;
	try {
		raw = readFileSync(configPath, 'utf8');
	} catch {
		return null;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}

	if (!parsed || typeof parsed !== 'object') return null;
	const value = (parsed as { baseten_model_id?: unknown }).baseten_model_id;
	if (typeof value === 'string' && value.trim().length > 0) return value.trim();
	return null;
}

// Baseten API key, read from the environment and NEVER from config.json — it must
// stay on the daemon and never be serialized to the phone. Call this only in
// server/daemon code (the WS upgrade handler / Baseten adapter), never in a load
// function or component that ships to the client. Uses process.env directly (not
// SvelteKit's $env) so this module stays importable by the standalone hook
// scripts. Returns null when unset or blank.
export function getBasetenApiKey(): string | null {
	const key = process.env.BASETEN_API_KEY;
	return key && key.trim().length > 0 ? key.trim() : null;
}
