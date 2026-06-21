import { test, expect } from 'bun:test';
import {
	raiseTerminalScript,
	parseActivateResult,
	applyActivateResult,
	pickMostRecentTty,
	pickTtyForWindow,
	focusPane,
	FocusError,
	sendKeysArgs,
	pasteBufferArgs,
	sendTextArgs,
	exitCopyModeArgs,
	exitCopyMode,
	parsePaneReadiness,
	sendKeys,
	sendText,
	submitPrompt,
	paneAcceptsInput,
	ensurePaneInputReady,
	InjectError,
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

test('raiseTerminalScript with cache resolves the window directly by id and binds it', () => {
	const cached: TabLocation = { windowId: 128573, tabIndex: 2 };
	const script = raiseTerminalScript('/dev/ttys003', cached);
	// Cached branch resolves the window in ONE Apple Event via `window id <id>`
	// and binds it to `w`, instead of walking every window comparing ids — that
	// walk made every warm tap O(window count × z-order depth) in Apple Events.
	// It still acts on the bound `w`: `set frontmost` against the bare
	// `window id <id>` specifier is silently dropped mid-activation, so the
	// bound form is what survives.
	expect(script).toContain('set w to window id 128573');
	expect(script).toContain('if tty of tab 2 of w is targetTTY then');
	expect(script).toContain('set selected of tab 2 of w to true');
	expect(script).toContain('set frontmost of w to true');
	expect(script).toContain('return "hit"');
	// The cached branch must NOT walk the window list comparing ids anymore.
	expect(script).not.toContain('if id of window wi is 128573 then');
	// Activation-transition guard must apply to cached taps too — the
	// cached branch is what runs on the second+ tap to a tty, and a
	// background-to-foreground transition still races without the delay.
	expect(script).toContain('set wasFront to frontmost');
	expect(script).toContain('if not wasFront then delay 0.2');
	// Must NOT issue `set frontmost` against the unbound window expression —
	// the bound `w` is what survives activation.
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

// pickMostRecentTty ─────────────────────────────────────────────────────────

test('pickMostRecentTty returns null on empty stdout', () => {
	expect(pickMostRecentTty('')).toBeNull();
});

test('pickMostRecentTty returns null on whitespace-only stdout', () => {
	expect(pickMostRecentTty('   \n  \t  \n')).toBeNull();
});

test('pickMostRecentTty returns the only tty when one client is attached', () => {
	expect(pickMostRecentTty('1700000000 /dev/ttys003\n')).toBe('/dev/ttys003');
});

// Core fix: when two terminals are attached to one session, the more-recently-
// active client's tty wins regardless of row order in tmux's output.
test('pickMostRecentTty picks the higher-activity tty when it appears second', () => {
	const stdout = '1700000000 /dev/ttys003\n1700000050 /dev/ttys009\n';
	expect(pickMostRecentTty(stdout)).toBe('/dev/ttys009');
});

test('pickMostRecentTty picks the higher-activity tty when it appears first', () => {
	const stdout = '1700000050 /dev/ttys009\n1700000000 /dev/ttys003\n';
	expect(pickMostRecentTty(stdout)).toBe('/dev/ttys009');
});

test('pickMostRecentTty picks any tty across a wide spread of clients', () => {
	const stdout = [
		'1700000010 /dev/ttys001',
		'1700001000 /dev/ttys999', // highest
		'1700000500 /dev/ttys555',
		'1700000100 /dev/ttys111'
	].join('\n');
	expect(pickMostRecentTty(stdout)).toBe('/dev/ttys999');
});

test('pickMostRecentTty skips rows missing the activity/tty separator', () => {
	const stdout = 'malformed-no-space\n1700000050 /dev/ttys009\n';
	expect(pickMostRecentTty(stdout)).toBe('/dev/ttys009');
});

test('pickMostRecentTty skips rows whose activity column is not numeric', () => {
	const stdout = 'notanumber /dev/ttys999\n1700000050 /dev/ttys009\n';
	expect(pickMostRecentTty(stdout)).toBe('/dev/ttys009');
});

test('pickMostRecentTty skips rows whose tty column is empty', () => {
	const stdout = '1700001000 \n1700000050 /dev/ttys009\n';
	expect(pickMostRecentTty(stdout)).toBe('/dev/ttys009');
});

test('pickMostRecentTty returns null when every row is malformed', () => {
	expect(pickMostRecentTty('garbage\nmore-garbage\nnotanumber tty\n')).toBeNull();
});

// pickTtyForWindow ──────────────────────────────────────────────────────────

test('pickTtyForWindow returns null on empty stdout', () => {
	expect(pickTtyForWindow('', '@5')).toBeNull();
});

test('pickTtyForWindow returns null when windowId is empty', () => {
	expect(pickTtyForWindow('1700000000|/dev/ttys003|@5\n', '')).toBeNull();
});

test('pickTtyForWindow returns the tty of the client displaying the window', () => {
	expect(pickTtyForWindow('1700000000|/dev/ttys003|@5\n', '@5')).toBe('/dev/ttys003');
});

// Core grouped-session fix: two tabs attached to the same window group, each
// client on a different current window. The tap must land on the client whose
// visible window matches the tapped pane's window, not whichever the session
// resolves to.
test('pickTtyForWindow ignores clients displaying a different window', () => {
	const stdout = ['1700000050|/dev/ttys003|@2', '1700000000|/dev/ttys009|@5'].join('\n');
	expect(pickTtyForWindow(stdout, '@5')).toBe('/dev/ttys009');
});

test('pickTtyForWindow returns null when no client currently displays the window', () => {
	const stdout = ['1700000050|/dev/ttys003|@2', '1700000000|/dev/ttys009|@7'].join('\n');
	expect(pickTtyForWindow(stdout, '@5')).toBeNull();
});

// Mirrored clients: two clients on one session both showing @5. Tiebreak by
// activity, matching pickMostRecentTty's behavior.
test('pickTtyForWindow breaks ties between same-window clients by activity', () => {
	const stdout = ['1700000000|/dev/ttys003|@5', '1700000050|/dev/ttys009|@5'].join('\n');
	expect(pickTtyForWindow(stdout, '@5')).toBe('/dev/ttys009');
});

test('pickTtyForWindow skips rows with fewer than three columns', () => {
	const stdout = ['1700001000|/dev/ttys999', '1700000050|/dev/ttys009|@5'].join('\n');
	expect(pickTtyForWindow(stdout, '@5')).toBe('/dev/ttys009');
});

test('pickTtyForWindow skips rows whose activity column is not numeric', () => {
	const stdout = ['notanumber|/dev/ttys999|@5', '1700000050|/dev/ttys009|@5'].join('\n');
	expect(pickTtyForWindow(stdout, '@5')).toBe('/dev/ttys009');
});

test('pickTtyForWindow skips rows whose tty column is empty', () => {
	const stdout = ['1700001000||@5', '1700000050|/dev/ttys009|@5'].join('\n');
	expect(pickTtyForWindow(stdout, '@5')).toBe('/dev/ttys009');
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

// sendKeysArgs ──────────────────────────────────────────────────────────────

test('sendKeysArgs builds send-keys argv with a single named key', () => {
	expect(sendKeysArgs('%5', ['Space'])).toEqual(['send-keys', '-t', '%5', 'Space']);
});

test('sendKeysArgs appends every key after the target in order', () => {
	expect(sendKeysArgs('%12', ['C-u', 'Enter'])).toEqual([
		'send-keys',
		'-t',
		'%12',
		'C-u',
		'Enter'
	]);
});

// pasteBufferArgs ───────────────────────────────────────────────────────────

// -d (delete after paste), -p (bracketed paste), -r (no LF→CR) and the named
// inject buffer are all load-bearing: -p/-r keep multi-line/special transcript
// text literal instead of submitting early, and the named buffer + -d keep the
// user's own paste buffers untouched.
test('pasteBufferArgs builds the bracketed self-deleting paste argv on the inject buffer', () => {
	expect(pasteBufferArgs('%5')).toEqual([
		'paste-buffer',
		'-d',
		'-p',
		'-r',
		'-b',
		'expediter-voice',
		'-t',
		'%5'
	]);
});

// sendTextArgs ──────────────────────────────────────────────────────────────

// -l sends literal text (no key-name lookup) and -- ends flag parsing so a suffix
// beginning with '-' isn't read as a flag — both matter for live-typing transcripts.
test('sendTextArgs builds a literal send-keys argv terminated with --', () => {
	expect(sendTextArgs('%5', 'hello world')).toEqual([
		'send-keys',
		'-t',
		'%5',
		'-l',
		'--',
		'hello world'
	]);
});

// exitCopyModeArgs ──────────────────────────────────────────────────────────

// -X dispatches `cancel` to the copy-mode command table (not the literal key),
// which is what leaves the mode and drops the pane back to the live prompt.
test('exitCopyModeArgs builds the copy-mode cancel argv', () => {
	expect(exitCopyModeArgs('%5')).toEqual(['send-keys', '-t', '%5', '-X', 'cancel']);
});

test('exitCopyMode rejects an invalid pane id with InjectError', async () => {
	expect(await captureThrow(() => exitCopyMode('14'))).toBeInstanceOf(InjectError);
});

// parsePaneReadiness ────────────────────────────────────────────────────────

test('parsePaneReadiness is ready when Claude Code is foreground and not in a mode', () => {
	expect(parsePaneReadiness('claude.exe|0')).toEqual({ ready: true });
});

test('parsePaneReadiness accepts the bare "claude" command name too', () => {
	expect(parsePaneReadiness('claude|0')).toEqual({ ready: true });
});

test('parsePaneReadiness refuses a non-Claude foreground process', () => {
	const r = parsePaneReadiness('zsh|0');
	expect(r.ready).toBe(false);
	if (!r.ready) {
		expect(r.reason).toContain('zsh');
		expect(r.code).toBe('not-claude');
	}
});

test('parsePaneReadiness flags copy-mode with a recoverable code', () => {
	// The `copy-mode` code is what ensurePaneInputReady keys off to auto-recover.
	const r = parsePaneReadiness('claude.exe|1');
	expect(r.ready).toBe(false);
	if (!r.ready) {
		expect(r.reason).toContain('copy-mode');
		expect(r.code).toBe('copy-mode');
	}
});

test('parsePaneReadiness codes malformed output as unreadable, not copy-mode', () => {
	for (const out of ['claude.exe', '', 'claude.exe|', 'claude.exe|2']) {
		const r = parsePaneReadiness(out);
		expect(r.ready).toBe(false);
		if (!r.ready) expect(r.code).toBe('unreadable');
	}
});

test('parsePaneReadiness trims surrounding whitespace before matching', () => {
	expect(parsePaneReadiness('  claude.exe|0\n')).toEqual({ ready: true });
});

test('parsePaneReadiness fails closed on output missing the separator', () => {
	expect(parsePaneReadiness('claude.exe').ready).toBe(false);
});

test('parsePaneReadiness fails closed on empty output', () => {
	expect(parsePaneReadiness('').ready).toBe(false);
});

test('parsePaneReadiness fails closed when the in-mode field is not a clean 0/1', () => {
	expect(parsePaneReadiness('claude.exe|').ready).toBe(false);
});

test('parsePaneReadiness honors a custom accepted-commands list', () => {
	expect(parsePaneReadiness('node|0', ['node'])).toEqual({ ready: true });
	expect(parsePaneReadiness('claude.exe|0', ['node']).ready).toBe(false);
});

// sendKeys / submitPrompt validation (invalid ids short-circuit before tmux) ──

test('sendKeys rejects an invalid pane id with InjectError', async () => {
	expect(await captureThrow(() => sendKeys('14', ['Space']))).toBeInstanceOf(InjectError);
});

test('sendKeys rejects an empty key list with InjectError', async () => {
	expect(await captureThrow(() => sendKeys('%5', []))).toBeInstanceOf(InjectError);
});

test('submitPrompt rejects an invalid pane id with InjectError', async () => {
	expect(await captureThrow(() => submitPrompt('%', 'hello world'))).toBeInstanceOf(InjectError);
});

test('sendText rejects an invalid pane id with InjectError', async () => {
	expect(await captureThrow(() => sendText('14', 'hi'))).toBeInstanceOf(InjectError);
});

test('sendText is a no-op for empty text on a valid pane (no tmux call, no throw)', async () => {
	// Empty text short-circuits before shelling out, so a valid pane id resolves cleanly.
	expect(await captureThrow(() => sendText('%5', ''))).toBeUndefined();
});

// paneAcceptsInput returns a verdict (never throws) for a bad id ─────────────

test('paneAcceptsInput returns not-ready for an invalid pane id without throwing', async () => {
	const r = await paneAcceptsInput('nope');
	expect(r.ready).toBe(false);
	if (!r.ready) expect(r.code).toBe('invalid-pane');
});

// ensurePaneInputReady — copy-mode recovery is a live-tmux path (exercised on
// device); without a tmux server we can still prove it never tries to recover a
// non-copy-mode blocker, returning the underlying verdict verbatim.
test('ensurePaneInputReady passes a non-copy-mode verdict straight through', async () => {
	const r = await ensurePaneInputReady('nope');
	expect(r.ready).toBe(false);
	if (!r.ready) expect(r.code).toBe('invalid-pane');
});
