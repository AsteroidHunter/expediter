import { test, expect } from 'bun:test';
import { HELPER_SOURCE } from './focusHost';

// The focus host replaced raiseTerminalScript, whose unit tests each encoded a
// hard-won invariant (one production incident apiece). The host's raise logic
// is a static JXA source string, so those invariants are enforced the same
// way — as content assertions. See HELPER_SOURCE's comments for the history.

test('host reads wasFront from System Events, never Terminal self-report', () => {
	// Terminal's own `frontmost` property self-reports false while Terminal is
	// the active app on a degraded LaunchServices, which would defeat the gate.
	expect(HELPER_SOURCE).toContain("SE.processes['Terminal']");
	expect(HELPER_SOURCE).toContain('proc.frontmost()');
	expect(HELPER_SOURCE).not.toContain('Terminal.frontmost()');
});

test('host gates both the raise and the settle delay on wasFront', () => {
	// A raise issued in the first ~200ms after background→front activation is
	// dropped ~9/10 while the window stack settles; an already-front Terminal
	// needs neither the raise nor the delay.
	expect(HELPER_SOURCE).toContain('if (!wasFront) {');
	expect(HELPER_SOURCE).toContain('proc.frontmost = true;');
	expect(HELPER_SOURCE).toContain('if (!wasFront) delay(0.2);');
});

test('host uses activate only as the Terminal-not-running recovery', () => {
	// AppleScript activate blocks ~2s per call on a degraded WindowServer; it
	// survives only in the catch around the System Events lookup (it also
	// launches Terminal). Exactly one call site (comments excluded), and it
	// lives in a catch.
	const code = HELPER_SOURCE.split('\n')
		.filter((l) => !l.trim().startsWith('//'))
		.join('\n');
	const matches = code.match(/Terminal\.activate\(\)/g) ?? [];
	expect(matches.length).toBe(1);
	expect(HELPER_SOURCE).toContain('} catch (e) {\n\t\tTerminal.activate();\n\t}');
});

test('host cached branch resolves by window id and validates the tty', () => {
	// One Apple Event to resolve the window, and the tab's tty is checked
	// before trusting a possibly-stale cache entry; failure falls through to
	// enumeration.
	expect(HELPER_SOURCE).toContain('Terminal.windows.byId(req.wid)');
	expect(HELPER_SOURCE).toContain("w.tabs[req.ti - 1].tty() === req.tty");
});

test('host enumeration reads each window ttys in one batched event', () => {
	// tabs.tty() is one Apple Event per window; per-tab reads made cold taps
	// O(window count × tab count).
	expect(HELPER_SOURCE).toContain('w.tabs.tty()');
});

test('host selects tabs without reordering window indices', () => {
	// `set index of w to 1` (JXA: w.index = ...) makes Terminal re-evaluate its
	// "primary" tab and snap focus elsewhere; selection + frontmost only.
	expect(HELPER_SOURCE).toContain('.selected = true;');
	expect(HELPER_SOURCE).toContain('w.frontmost = true;');
	expect(HELPER_SOURCE).not.toContain('.index =');
});

test('host replies with the parseActivateResult token vocabulary', () => {
	expect(HELPER_SOURCE).toContain("return 'hit'");
	expect(HELPER_SOURCE).toContain("return 'miss:' + w.id() + ':' + (ti + 1)");
	expect(HELPER_SOURCE).toContain("return 'notfound'");
	expect(HELPER_SOURCE).toContain("return 'activated'");
});

test('host warm op emits parseWarmCache-compatible rows', () => {
	expect(HELPER_SOURCE).toContain("wid + '|' + (ti + 1) + '|' + ttys[ti]");
	expect(HELPER_SOURCE).toContain("rows.join(';')");
});
