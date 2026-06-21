import { test, expect } from 'bun:test';
import { existsSync } from 'node:fs';
import { resolveBridgePath, installTmuxHooks } from './tmuxHooks';

// ─── resolveBridgePath ───────────────────────────────────────────────────────

test('resolveBridgePath locates the committed bridge script', () => {
	const p = resolveBridgePath();
	expect(p).not.toBeNull();
	expect(p?.endsWith('bin/expediter-tmux-hook.sh')).toBe(true);
	expect(existsSync(p as string)).toBe(true);
});

// ─── installTmuxHooks ────────────────────────────────────────────────────────

test('installTmuxHooks sets -g client-attached/-detached with the quoted bridge', async () => {
	const calls: string[][] = [];
	const issued = await installTmuxHooks('/home/u/exp/bin/expediter-tmux-hook.sh', async (args) => {
		calls.push(args);
	});
	expect(issued.length).toBe(2);
	expect(calls).toEqual([
		['set-hook', '-g', 'client-attached', 'run-shell -b "/home/u/exp/bin/expediter-tmux-hook.sh"'],
		['set-hook', '-g', 'client-detached', 'run-shell -b "/home/u/exp/bin/expediter-tmux-hook.sh"']
	]);
});

test('installTmuxHooks no-ops when the bridge cannot be located', async () => {
	const calls: string[][] = [];
	const issued = await installTmuxHooks(null, async (args) => {
		calls.push(args);
	});
	expect(issued).toEqual([]);
	expect(calls.length).toBe(0);
});

test('installTmuxHooks swallows a failing tmux runner (best-effort, no throw)', async () => {
	const issued = await installTmuxHooks('/x/bin/expediter-tmux-hook.sh', async () => {
		throw new Error('no server running');
	});
	expect(issued).toEqual([]); // both attempts threw → nothing recorded as issued
});
