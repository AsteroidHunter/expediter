import { test, expect, beforeEach, afterEach } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Focused tests for bin/codex-hooks-merge.py — the Codex hooks.json writer +
// hooks.state trust-entry writer shared by install.sh / update.sh /
// uninstall.sh (and mirrored inside install-remote.sh). Runs the real python3
// against a scratch CODEX_HOME per test.

const SCRIPT = path.resolve(
	path.dirname(new URL(import.meta.url).pathname),
	'../../../bin/codex-hooks-merge.py'
);

let codexHome: string;

beforeEach(() => {
	codexHome = mkdtempSync(path.join(os.tmpdir(), 'expediter-codex-home-'));
});

afterEach(() => {
	rmSync(codexHome, { recursive: true, force: true });
});

function run(hookScript: string, uninstall = false): { status: number; out: string; err: string } {
	const args = [SCRIPT, codexHome, hookScript];
	if (uninstall) args.push('--uninstall');
	const res = spawnSync('python3', args, { encoding: 'utf8' });
	return { status: res.status ?? -1, out: res.stdout, err: res.stderr };
}

function readHooks(): Record<string, unknown> {
	return JSON.parse(readFileSync(path.join(codexHome, 'hooks.json'), 'utf8'));
}

function readConfig(): string {
	return readFileSync(path.join(codexHome, 'config.toml'), 'utf8');
}

const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop', 'PermissionRequest'];

test('fresh merge writes the 5-event hooks.json and 5 trust entries', () => {
	const res = run('/opt/expediter/bin/expediter-hook.sh');
	expect(res.status).toBe(0);

	const hooks = (readHooks() as { hooks: Record<string, unknown[]> }).hooks;
	for (const ev of EVENTS) {
		expect(hooks[ev]).toEqual([
			{ hooks: [{ type: 'command', command: `/opt/expediter/bin/expediter-hook.sh ${ev}` }] }
		]);
	}

	const config = readConfig();
	const canonical = `${require('node:fs').realpathSync(codexHome)}/hooks.json`;
	// The plan's pinned test vector: command `/opt/expediter/bin/expediter-hook.sh
	// Stop` on event `stop` hashes to this exact digest.
	expect(config).toContain(`[hooks.state."${canonical}:stop:0:0"]`);
	expect(config).toContain(
		'trusted_hash = "sha256:517624cc21ff07a895d832c08e285d3900a77e6fd7cb60f8c1b64632d1e1e972"'
	);
	for (const label of ['session_start', 'user_prompt_submit', 'post_tool_use', 'permission_request']) {
		expect(config).toContain(`[hooks.state."${canonical}:${label}:0:0"]`);
	}
});

test('re-running the merge is byte-idempotent and reports 0 added', () => {
	run('/opt/expediter/bin/expediter-hook.sh');
	const hooksBefore = readFileSync(path.join(codexHome, 'hooks.json'), 'utf8');
	const configBefore = readConfig();

	const res = run('/opt/expediter/bin/expediter-hook.sh');
	expect(res.status).toBe(0);
	expect(res.out).toContain('0 added');
	expect(readFileSync(path.join(codexHome, 'hooks.json'), 'utf8')).toBe(hooksBefore);
	expect(readConfig()).toBe(configBefore);
});

test('user hook groups and foreign trust entries pass through untouched', () => {
	writeFileSync(
		path.join(codexHome, 'hooks.json'),
		JSON.stringify({
			hooks: {
				Stop: [{ hooks: [{ type: 'command', command: '/home/user/my-own-hook.sh' }] }]
			}
		})
	);
	writeFileSync(
		path.join(codexHome, 'config.toml'),
		[
			'model = "gpt-5.6-sol"',
			'',
			'[projects."/tmp/x"]',
			'trust_level = "trusted"',
			'',
			'[hooks.state."/somewhere/else/hooks.json:stop:0:0"]',
			'trusted_hash = "sha256:aaaa"',
			''
		].join('\n')
	);

	const res = run('/opt/expediter/bin/expediter-hook.sh');
	expect(res.status).toBe(0);

	const hooks = (readHooks() as { hooks: Record<string, unknown[]> }).hooks;
	// The user's group keeps index 0; ours appends at index 1.
	expect((hooks.Stop as unknown[]).length).toBe(2);
	expect(JSON.stringify((hooks.Stop as unknown[])[0])).toContain('my-own-hook.sh');

	const config = readConfig();
	expect(config).toContain('model = "gpt-5.6-sol"');
	expect(config).toContain('[projects."/tmp/x"]');
	expect(config).toContain('[hooks.state."/somewhere/else/hooks.json:stop:0:0"]');
	// Ours is keyed by its real post-merge index (group 1).
	const canonical = `${require('node:fs').realpathSync(codexHome)}/hooks.json`;
	expect(config).toContain(`[hooks.state."${canonical}:stop:1:0"]`);
});

test('a moved repo path updates the command in place and rewrites the trust hash', () => {
	run('/old/location/bin/expediter-hook.sh');
	const configOld = readConfig();

	const res = run('/new/location/bin/expediter-hook.sh');
	expect(res.status).toBe(0);
	expect(res.out).toContain('5 updated');

	const hooks = (readHooks() as { hooks: Record<string, unknown[]> }).hooks;
	for (const ev of EVENTS) {
		expect((hooks[ev] as unknown[]).length).toBe(1); // no duplicate groups
		expect(JSON.stringify(hooks[ev])).toContain(`/new/location/bin/expediter-hook.sh ${ev}`);
	}
	const config = readConfig();
	expect(config).not.toBe(configOld);
	// Same keys (index stable), new hashes; exactly one block per key.
	const canonical = `${require('node:fs').realpathSync(codexHome)}/hooks.json`;
	const occurrences = config.split(`[hooks.state."${canonical}:stop:0:0"]`).length - 1;
	expect(occurrences).toBe(1);
});

test('malformed hooks.json refuses and leaves the file untouched', () => {
	const hooksPath = path.join(codexHome, 'hooks.json');
	writeFileSync(hooksPath, '{not valid json');
	const res = run('/opt/expediter/bin/expediter-hook.sh');
	expect(res.status).not.toBe(0);
	expect(res.err).toContain('not valid JSON');
	expect(readFileSync(hooksPath, 'utf8')).toBe('{not valid json');
});

test('uninstall removes our groups and trust entries, keeps user ones', () => {
	writeFileSync(
		path.join(codexHome, 'hooks.json'),
		JSON.stringify({
			hooks: {
				Stop: [{ hooks: [{ type: 'command', command: '/home/user/my-own-hook.sh' }] }]
			}
		})
	);
	writeFileSync(
		path.join(codexHome, 'config.toml'),
		'[hooks.state."/somewhere/else/hooks.json:stop:0:0"]\ntrusted_hash = "sha256:aaaa"\n'
	);
	run('/opt/expediter/bin/expediter-hook.sh');
	expect((readHooks() as { hooks: Record<string, unknown[]> }).hooks.Stop.length).toBe(2);

	const res = run('/opt/expediter/bin/expediter-hook.sh', true);
	expect(res.status).toBe(0);
	expect(res.out).toContain('5 group(s)');

	const hooks = (readHooks() as { hooks: Record<string, unknown[]> }).hooks;
	expect(hooks.Stop.length).toBe(1);
	expect(JSON.stringify(hooks.Stop[0])).toContain('my-own-hook.sh');
	expect(hooks.SessionStart).toBeUndefined(); // emptied events pruned

	const config = readConfig();
	expect(config).toContain('/somewhere/else/hooks.json'); // foreign entry kept
	expect(config).not.toContain('expediter'); // all our keys gone
	const canonical = `${require('node:fs').realpathSync(codexHome)}/hooks.json`;
	expect(config).not.toContain(`${canonical}:stop`);
});

test('uninstall with no files present is a clean no-op', () => {
	const res = run('/opt/expediter/bin/expediter-hook.sh', true);
	expect(res.status).toBe(0);
	expect(existsSync(path.join(codexHome, 'hooks.json'))).toBe(false);
	expect(existsSync(path.join(codexHome, 'config.toml'))).toBe(false);
});

test('refuses to append a duplicate trust key written in an unrecognized shape', () => {
	// The same key expressed as an inline assignment rather than a table
	// header — the splicer must refuse rather than produce a duplicate table.
	const canonical = `${require('node:fs').realpathSync(codexHome)}/hooks.json`;
	writeFileSync(
		path.join(codexHome, 'config.toml'),
		`[hooks.state]\n"${canonical}:stop:0:0" = { trusted_hash = "sha256:bbbb" }\n`
	);
	const res = run('/opt/expediter/bin/expediter-hook.sh');
	expect(res.status).not.toBe(0);
	expect(res.err).toContain('unrecognized format');
});
