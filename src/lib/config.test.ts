import { test, expect, beforeEach, afterEach } from 'bun:test';
import { writeFileSync, unlinkSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';
import {
	getRefreshInterval,
	getTitleSource,
	getSttBackend,
	getBasetenModelId,
	getBasetenApiKey,
	setSttBackend
} from './config';

let tmpDir: string;
let configFile: string;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), 'expediter-config-test-'));
	configFile = join(tmpDir, 'config.json');
});

afterEach(() => {
	try {
		unlinkSync(configFile);
	} catch {
		/* may not exist */
	}
	rmSync(tmpDir, { recursive: true, force: true });
});

test('returns default 5 when the config file does not exist', () => {
	expect(getRefreshInterval(configFile)).toBe(5);
});

test('returns title_refresh_every when present and valid', () => {
	writeFileSync(configFile, JSON.stringify({ title_refresh_every: 8 }), 'utf8');
	expect(getRefreshInterval(configFile)).toBe(8);
});

test('returns default 5 when JSON is malformed', () => {
	writeFileSync(configFile, '{title_refresh_every: 8', 'utf8');
	expect(getRefreshInterval(configFile)).toBe(5);
});

test('returns default 5 when title_refresh_every is zero', () => {
	writeFileSync(configFile, JSON.stringify({ title_refresh_every: 0 }), 'utf8');
	expect(getRefreshInterval(configFile)).toBe(5);
});

test('returns default 5 when title_refresh_every is negative', () => {
	writeFileSync(configFile, JSON.stringify({ title_refresh_every: -3 }), 'utf8');
	expect(getRefreshInterval(configFile)).toBe(5);
});

test('returns default 5 when title_refresh_every is a non-integer float', () => {
	writeFileSync(configFile, JSON.stringify({ title_refresh_every: 4.5 }), 'utf8');
	expect(getRefreshInterval(configFile)).toBe(5);
});

test('returns default 5 when title_refresh_every is a string', () => {
	writeFileSync(configFile, JSON.stringify({ title_refresh_every: 'five' }), 'utf8');
	expect(getRefreshInterval(configFile)).toBe(5);
});

test('returns default 5 when the JSON is not an object (e.g. array)', () => {
	writeFileSync(configFile, JSON.stringify([5]), 'utf8');
	expect(getRefreshInterval(configFile)).toBe(5);
});

test('ignores unknown top-level keys (forward-compat)', () => {
	writeFileSync(
		configFile,
		JSON.stringify({ title_refresh_every: 7, future_setting: 'whatever' }),
		'utf8'
	);
	expect(getRefreshInterval(configFile)).toBe(7);
});

test('returns the new value when the file is rewritten between calls (no caching)', () => {
	writeFileSync(configFile, JSON.stringify({ title_refresh_every: 3 }), 'utf8');
	expect(getRefreshInterval(configFile)).toBe(3);

	writeFileSync(configFile, JSON.stringify({ title_refresh_every: 11 }), 'utf8');
	expect(getRefreshInterval(configFile)).toBe(11);
});

test('getTitleSource returns default "chat-title" when the file does not exist', () => {
	expect(getTitleSource(configFile)).toBe('chat-title');
});

test('getTitleSource returns "chat-title" when set explicitly', () => {
	writeFileSync(configFile, JSON.stringify({ title_source: 'chat-title' }), 'utf8');
	expect(getTitleSource(configFile)).toBe('chat-title');
});

test('getTitleSource returns "haiku" when set explicitly', () => {
	writeFileSync(configFile, JSON.stringify({ title_source: 'haiku' }), 'utf8');
	expect(getTitleSource(configFile)).toBe('haiku');
});

test('getTitleSource returns default "chat-title" when JSON is malformed', () => {
	writeFileSync(configFile, '{title_source: "haiku"', 'utf8');
	expect(getTitleSource(configFile)).toBe('chat-title');
});

test('getTitleSource returns default "chat-title" when value is an unknown string', () => {
	writeFileSync(configFile, JSON.stringify({ title_source: 'gemini' }), 'utf8');
	expect(getTitleSource(configFile)).toBe('chat-title');
});

test('getTitleSource returns default "chat-title" when value is not a string', () => {
	writeFileSync(configFile, JSON.stringify({ title_source: 42 }), 'utf8');
	expect(getTitleSource(configFile)).toBe('chat-title');
});

test('getTitleSource returns default "chat-title" when JSON is not an object', () => {
	writeFileSync(configFile, JSON.stringify(['haiku']), 'utf8');
	expect(getTitleSource(configFile)).toBe('chat-title');
});

test('getTitleSource and getRefreshInterval coexist in the same config file', () => {
	writeFileSync(
		configFile,
		JSON.stringify({ title_source: 'haiku', title_refresh_every: 9 }),
		'utf8'
	);
	expect(getTitleSource(configFile)).toBe('haiku');
	expect(getRefreshInterval(configFile)).toBe(9);
});

// getSttBackend ─────────────────────────────────────────────────────────────

test('getSttBackend defaults to "voice" when the file does not exist', () => {
	expect(getSttBackend(configFile)).toBe('voice');
});

test('getSttBackend returns "baseten" when set explicitly', () => {
	writeFileSync(configFile, JSON.stringify({ stt_backend: 'baseten' }), 'utf8');
	expect(getSttBackend(configFile)).toBe('baseten');
});

test('getSttBackend returns "voice" when set explicitly', () => {
	writeFileSync(configFile, JSON.stringify({ stt_backend: 'voice' }), 'utf8');
	expect(getSttBackend(configFile)).toBe('voice');
});

test('getSttBackend defaults to "voice" when JSON is malformed', () => {
	writeFileSync(configFile, '{stt_backend: "baseten"', 'utf8');
	expect(getSttBackend(configFile)).toBe('voice');
});

test('getSttBackend defaults to "voice" on an unknown backend string', () => {
	writeFileSync(configFile, JSON.stringify({ stt_backend: 'deepgram' }), 'utf8');
	expect(getSttBackend(configFile)).toBe('voice');
});

test('getSttBackend defaults to "voice" when value is not a string', () => {
	writeFileSync(configFile, JSON.stringify({ stt_backend: 1 }), 'utf8');
	expect(getSttBackend(configFile)).toBe('voice');
});

test('getSttBackend defaults to "voice" when JSON is not an object', () => {
	writeFileSync(configFile, JSON.stringify(['baseten']), 'utf8');
	expect(getSttBackend(configFile)).toBe('voice');
});

// getBasetenModelId ─────────────────────────────────────────────────────────

test('getBasetenModelId returns null when the file does not exist', () => {
	expect(getBasetenModelId(configFile)).toBeNull();
});

test('getBasetenModelId returns the id when set', () => {
	writeFileSync(configFile, JSON.stringify({ baseten_model_id: 'abcd1234' }), 'utf8');
	expect(getBasetenModelId(configFile)).toBe('abcd1234');
});

test('getBasetenModelId trims surrounding whitespace', () => {
	writeFileSync(configFile, JSON.stringify({ baseten_model_id: '  abcd1234  ' }), 'utf8');
	expect(getBasetenModelId(configFile)).toBe('abcd1234');
});

test('getBasetenModelId returns null on a blank string', () => {
	writeFileSync(configFile, JSON.stringify({ baseten_model_id: '   ' }), 'utf8');
	expect(getBasetenModelId(configFile)).toBeNull();
});

test('getBasetenModelId returns null when value is not a string', () => {
	writeFileSync(configFile, JSON.stringify({ baseten_model_id: 42 }), 'utf8');
	expect(getBasetenModelId(configFile)).toBeNull();
});

test('stt settings coexist with the title settings in one file', () => {
	writeFileSync(
		configFile,
		JSON.stringify({ stt_backend: 'baseten', baseten_model_id: 'm1', title_source: 'haiku' }),
		'utf8'
	);
	expect(getSttBackend(configFile)).toBe('baseten');
	expect(getBasetenModelId(configFile)).toBe('m1');
	expect(getTitleSource(configFile)).toBe('haiku');
});

// getBasetenApiKey (env-backed, not config.json) ─────────────────────────────

test('getBasetenApiKey reads BASETEN_API_KEY from the environment, null when unset', () => {
	const saved = process.env.BASETEN_API_KEY;
	try {
		delete process.env.BASETEN_API_KEY;
		expect(getBasetenApiKey()).toBeNull();
		process.env.BASETEN_API_KEY = '  secret-key  ';
		expect(getBasetenApiKey()).toBe('secret-key');
		process.env.BASETEN_API_KEY = '   ';
		expect(getBasetenApiKey()).toBeNull();
	} finally {
		if (saved === undefined) delete process.env.BASETEN_API_KEY;
		else process.env.BASETEN_API_KEY = saved;
	}
});

// setSttBackend (settings UI write path) ────────────────────────────────────

test('setSttBackend writes a backend that getSttBackend reads back (round-trip)', () => {
	setSttBackend('baseten', configFile);
	expect(getSttBackend(configFile)).toBe('baseten');
	setSttBackend('voice', configFile);
	expect(getSttBackend(configFile)).toBe('voice');
});

test('setSttBackend merges, preserving other settings in the file', () => {
	writeFileSync(
		configFile,
		JSON.stringify({ title_source: 'haiku', title_refresh_every: 9, baseten_model_id: 'm1' }),
		'utf8'
	);
	setSttBackend('baseten', configFile);
	expect(getSttBackend(configFile)).toBe('baseten');
	expect(getTitleSource(configFile)).toBe('haiku');
	expect(getRefreshInterval(configFile)).toBe(9);
	expect(getBasetenModelId(configFile)).toBe('m1');
});

test('setSttBackend creates a clean object when the existing file is corrupt', () => {
	writeFileSync(configFile, '{not valid json', 'utf8');
	setSttBackend('voice', configFile);
	const parsed = JSON.parse(readFileSync(configFile, 'utf8'));
	expect(parsed).toEqual({ stt_backend: 'voice' });
});
