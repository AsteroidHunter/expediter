import { test, expect, beforeEach, afterEach } from 'bun:test';
import { writeFileSync, unlinkSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getRefreshInterval } from './config';

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
