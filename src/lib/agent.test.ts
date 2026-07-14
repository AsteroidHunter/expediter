import { test, expect } from 'bun:test';
import { agentForPath, agentForCommand } from './agent';

// ─── agentForPath (segment-based, not home-prefix-based) ────────────────────

test('agentForPath classifies local claude transcript paths', () => {
	expect(
		agentForPath('/Users/x/.claude/projects/-Users-x-proj/abc-123.jsonl')
	).toBe('claude');
});

test('agentForPath classifies local codex rollout paths', () => {
	expect(
		agentForPath('/Users/x/.codex/sessions/2026/07/14/rollout-2026-07-14T11-42-25-019f.jsonl')
	).toBe('codex');
});

test('agentForPath classifies far-side remote paths (no local home prefix)', () => {
	expect(agentForPath('/home/bob/.codex/sessions/2026/07/14/rollout-x.jsonl')).toBe('codex');
	expect(agentForPath('/home/bob/.claude/projects/-home-bob-proj/t.jsonl')).toBe('claude');
	// Linux-style root user path
	expect(agentForPath('/root/.codex/sessions/2026/01/01/rollout-y.jsonl')).toBe('codex');
});

test('agentForPath returns null for paths under neither segment', () => {
	expect(agentForPath('/etc/passwd')).toBeNull();
	expect(agentForPath('/Users/x/projects/foo/bar.jsonl')).toBeNull();
	expect(agentForPath('')).toBeNull();
});

test('agentForPath requires the exact dot-dir segment, not a substring', () => {
	// `.claude2` / `.codexfoo` directories must not classify.
	expect(agentForPath('/Users/x/.claude2/projects/t.jsonl')).toBeNull();
	expect(agentForPath('/Users/x/.codexfoo/sessions/r.jsonl')).toBeNull();
});

test('agentForPath picks the deeper segment when a path contains both', () => {
	// Pathological but well-defined: the nearest ancestor of the file wins.
	expect(agentForPath('/Users/x/.claude/stuff/.codex/sessions/r.jsonl')).toBe('codex');
	expect(agentForPath('/Users/x/.codex/stuff/.claude/projects/t.jsonl')).toBe('claude');
});

// ─── agentForCommand ─────────────────────────────────────────────────────────

test('agentForCommand maps the known agent binaries', () => {
	expect(agentForCommand('claude')).toBe('claude');
	expect(agentForCommand('claude.exe')).toBe('claude');
	expect(agentForCommand('codex')).toBe('codex');
	expect(agentForCommand('codex.exe')).toBe('codex');
});

test('agentForCommand rejects shells, editors, and look-alikes', () => {
	expect(agentForCommand('bash')).toBeNull();
	expect(agentForCommand('zsh')).toBeNull();
	expect(agentForCommand('ssh')).toBeNull();
	expect(agentForCommand('claudette')).toBeNull();
	expect(agentForCommand('codexx')).toBeNull();
	expect(agentForCommand('')).toBeNull();
});
