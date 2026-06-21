import { test, expect } from 'bun:test';
import { parseUpgradeRequest, tryClaimPane, releasePane, VOICE_WS_PATH } from './voiceSocket';

// parseUpgradeRequest drives the inline auth/validation gate on the WS upgrade
// (hooks.server.ts never runs on an upgrade), so its parsing is worth pinning down.

test('parseUpgradeRequest pulls the path, token, and pane from the query string', () => {
	expect(parseUpgradeRequest('/api/voice/stream?token=abc123&pane=%5')).toEqual({
		path: '/api/voice/stream',
		token: 'abc123',
		pane: '%5'
	});
});

test('the parsed path matches the exported VOICE_WS_PATH constant', () => {
	expect(parseUpgradeRequest(`${VOICE_WS_PATH}?token=t&pane=%1`).path).toBe(VOICE_WS_PATH);
});

test('parseUpgradeRequest returns null token/pane when absent', () => {
	expect(parseUpgradeRequest('/api/voice/stream')).toEqual({
		path: '/api/voice/stream',
		token: null,
		pane: null
	});
});

test('parseUpgradeRequest preserves a non-voice path so the gate can reject it', () => {
	expect(parseUpgradeRequest('/api/stream?t=x').path).toBe('/api/stream');
});

test('parseUpgradeRequest url-decodes the pane parameter', () => {
	// %25 → %, so a pane sent url-encoded as %255 decodes to %5... but the phone
	// sends the literal pane id; verify a plainly-encoded value round-trips.
	expect(parseUpgradeRequest('/api/voice/stream?pane=%2512').pane).toBe('%12');
});

// The per-pane claim keeps two audio connections from interleaving keystrokes
// into one pane. Pure pair; the upgrade gate takes the claim, finish() releases.

test('tryClaimPane: first claim wins, second is refused until release', () => {
	expect(tryClaimPane('%7701')).toBe(true);
	expect(tryClaimPane('%7701')).toBe(false);
	releasePane('%7701');
	expect(tryClaimPane('%7701')).toBe(true);
	releasePane('%7701');
});

test('claims are per pane — one pane does not block another', () => {
	expect(tryClaimPane('%7702')).toBe(true);
	expect(tryClaimPane('%7703')).toBe(true);
	releasePane('%7702');
	releasePane('%7703');
});

test('releasePane is idempotent (double release cannot free a later claim twice)', () => {
	expect(tryClaimPane('%7704')).toBe(true);
	releasePane('%7704');
	releasePane('%7704');
	expect(tryClaimPane('%7704')).toBe(true);
	expect(tryClaimPane('%7704')).toBe(false);
	releasePane('%7704');
});
