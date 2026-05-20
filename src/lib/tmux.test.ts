import { test, expect } from 'bun:test';
import {
	raiseTerminalScript,
	parseActivateResult,
	applyActivateResult,
	focusPane,
	FocusError,
	type TabLocation
} from './tmux';

// raiseTerminalScript ───────────────────────────────────────────────────────

test('raiseTerminalScript with null tty returns activate-only script', () => {
	const script = raiseTerminalScript(null, null);
	expect(script).toBe('tell application "Terminal" to activate');
	expect(script).not.toContain('repeat');
	expect(script).not.toContain('targetTTY');
});

test('raiseTerminalScript with tty and no cache emits enumeration branch only', () => {
	const script = raiseTerminalScript('/dev/ttys003', null);
	expect(script).toContain('set targetTTY to "/dev/ttys003"');
	expect(script).toContain('repeat with wi from 1 to (count of windows)');
	expect(script).toContain('return "miss:" & wid & ":" & ti');
	expect(script).toContain('return "notfound"');
	expect(script).not.toContain('return "hit"');
	// Activation-transition guard: capture frontmost before activate and
	// gate a 200ms settle delay on Terminal not already being foregrounded.
	// Without this delay, `set frontmost` issued during activation is
	// silently dropped and the wrong window lands frontmost.
	expect(script).toContain('set wasFront to frontmost');
	expect(script).toContain('if not wasFront then delay 0.2');
});

test('raiseTerminalScript with cache resolves id to a bound window before setting frontmost', () => {
	const cached: TabLocation = { windowId: 128573, tabIndex: 2 };
	const script = raiseTerminalScript('/dev/ttys003', cached);
	// Cached branch looks up the window by id, binds it to `w`, then operates
	// on `w`. The bind adds an Apple Event roundtrip that lets Terminal's
	// activation transition settle — without it, `set frontmost` issued
	// immediately after `activate` is silently dropped from background.
	expect(script).toContain('if id of window wi is 128573 then');
	expect(script).toContain('set w to window wi');
	expect(script).toContain('if tty of tab 2 of w is targetTTY then');
	expect(script).toContain('set selected of tab 2 of w to true');
	expect(script).toContain('set frontmost of w to true');
	expect(script).toContain('return "hit"');
	// Activation-transition guard must apply to cached taps too — the
	// cached branch is what runs on the second+ tap to a tty, and a
	// background-to-foreground transition still races without the delay.
	expect(script).toContain('set wasFront to frontmost');
	expect(script).toContain('if not wasFront then delay 0.2');
	// Must NOT issue `set frontmost` against the unbound window expression
	// from the cached branch — the bound form is what survives activation.
	expect(script).not.toContain('set frontmost of window id 128573 to true');
	expect(script).not.toContain('set frontmost of window wi to true');
	// Enumeration fallback must still be present so a stale cache misses gracefully.
	expect(script).toContain('return "miss:" & wid & ":" & ti');
});

test('raiseTerminalScript escapes embedded double quotes in tty', () => {
	const script = raiseTerminalScript('/dev/ttys"injected', null);
	expect(script).toContain('set targetTTY to "/dev/ttys\\"injected"');
});

// parseActivateResult ───────────────────────────────────────────────────────

test('parseActivateResult parses "hit"', () => {
	expect(parseActivateResult('hit')).toEqual({ kind: 'hit' });
});

test('parseActivateResult parses "notfound"', () => {
	expect(parseActivateResult('notfound')).toEqual({ kind: 'notfound' });
});

test('parseActivateResult parses well-formed miss', () => {
	expect(parseActivateResult('miss:128573:2')).toEqual({
		kind: 'miss',
		windowId: 128573,
		tabIndex: 2
	});
});

test('parseActivateResult treats miss with non-numeric indices as unknown', () => {
	expect(parseActivateResult('miss:abc:def')).toEqual({
		kind: 'unknown',
		raw: 'miss:abc:def'
	});
});

test('parseActivateResult trims surrounding whitespace before matching', () => {
	expect(parseActivateResult('  hit  \n')).toEqual({ kind: 'hit' });
	expect(parseActivateResult('\tmiss:1:2\n')).toEqual({
		kind: 'miss',
		windowId: 1,
		tabIndex: 2
	});
});

test('parseActivateResult returns unknown for empty or unrecognized output', () => {
	expect(parseActivateResult('')).toEqual({ kind: 'unknown', raw: '' });
	expect(parseActivateResult('garbage')).toEqual({ kind: 'unknown', raw: 'garbage' });
});

// applyActivateResult ───────────────────────────────────────────────────────

test('applyActivateResult on miss sets the cache entry', () => {
	const cache = new Map<string, TabLocation>();
	applyActivateResult(cache, '/dev/ttys003', { kind: 'miss', windowId: 1, tabIndex: 2 });
	expect(cache.get('/dev/ttys003')).toEqual({ windowId: 1, tabIndex: 2 });
});

test('applyActivateResult on miss overwrites an existing entry', () => {
	const cache = new Map<string, TabLocation>([
		['/dev/ttys003', { windowId: 1, tabIndex: 2 }]
	]);
	applyActivateResult(cache, '/dev/ttys003', { kind: 'miss', windowId: 9, tabIndex: 5 });
	expect(cache.get('/dev/ttys003')).toEqual({ windowId: 9, tabIndex: 5 });
});

test('applyActivateResult on notfound deletes an existing entry', () => {
	const cache = new Map<string, TabLocation>([
		['/dev/ttys003', { windowId: 1, tabIndex: 2 }]
	]);
	applyActivateResult(cache, '/dev/ttys003', { kind: 'notfound' });
	expect(cache.has('/dev/ttys003')).toBe(false);
});

test('applyActivateResult on notfound for an absent entry is a no-op', () => {
	const cache = new Map<string, TabLocation>();
	applyActivateResult(cache, '/dev/ttys003', { kind: 'notfound' });
	expect(cache.size).toBe(0);
});

test('applyActivateResult on hit leaves the cache unchanged', () => {
	const cache = new Map<string, TabLocation>([
		['/dev/ttys003', { windowId: 1, tabIndex: 2 }]
	]);
	applyActivateResult(cache, '/dev/ttys003', { kind: 'hit' });
	expect(cache.get('/dev/ttys003')).toEqual({ windowId: 1, tabIndex: 2 });
});

test('applyActivateResult on unknown preserves a stale entry rather than evicting', () => {
	// Defensive: a malformed osascript response should not blow away a
	// previously-valid cache entry. The next call will re-verify naturally.
	const cache = new Map<string, TabLocation>([
		['/dev/ttys003', { windowId: 1, tabIndex: 2 }]
	]);
	applyActivateResult(cache, '/dev/ttys003', { kind: 'unknown', raw: 'garbage' });
	expect(cache.get('/dev/ttys003')).toEqual({ windowId: 1, tabIndex: 2 });
});

// focusPane validation ─────────────────────────────────────────────────────

// bun:test's `.rejects` matcher works at runtime but isn't in the type
// definitions, which trips svelte-check. Existing tests in this repo don't
// use it either, so we use a try/catch helper to stay consistent with the
// codebase and keep the type checker happy.
async function captureThrow(fn: () => Promise<unknown>): Promise<unknown> {
	try {
		await fn();
		return undefined;
	} catch (e) {
		return e;
	}
}

test('focusPane rejects empty pane id with FocusError', async () => {
	expect(await captureThrow(() => focusPane(''))).toBeInstanceOf(FocusError);
});

test('focusPane rejects pane id without leading %', async () => {
	expect(await captureThrow(() => focusPane('14'))).toBeInstanceOf(FocusError);
});

test('focusPane rejects pane id with non-numeric body', async () => {
	expect(await captureThrow(() => focusPane('%abc'))).toBeInstanceOf(FocusError);
});

test('focusPane rejects bare %', async () => {
	expect(await captureThrow(() => focusPane('%'))).toBeInstanceOf(FocusError);
});

test('focusPane rejects mixed body', async () => {
	expect(await captureThrow(() => focusPane('%1a'))).toBeInstanceOf(FocusError);
});
