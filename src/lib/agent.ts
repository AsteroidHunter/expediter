// Single source of truth for per-agent discrimination (plan: codex-compatibility).
// Expediter drives two coding agents — Claude Code and OpenAI's Codex CLI — and
// everything agent-specific hangs off this discriminator: transcript root and
// schema, title source, decline matcher, summarizer command, pane binary set,
// hook-file target. Everything downstream of a ticket (state machine, SSE,
// tmux plumbing, phone UI) is agent-neutral.
export type Agent = 'claude' | 'codex';

// Path → agent, matched by SEGMENT (`/.claude/` vs `/.codex/`), not by
// local-home prefix: a remote payload carries the far box's transcript_path
// (e.g. /home/bob/.codex/sessions/…), which never starts with the local home
// but classifies identically by segment. When a pathological path contains
// both segments, the deeper (last) one wins — it is the nearest ancestor of
// the transcript file.
const AGENT_SEGMENTS: Array<{ agent: Agent; segment: string }> = [
	{ agent: 'claude', segment: '/.claude/' },
	{ agent: 'codex', segment: '/.codex/' }
];

export function agentForPath(p: string): Agent | null {
	let best: Agent | null = null;
	let bestIndex = -1;
	for (const { agent, segment } of AGENT_SEGMENTS) {
		const idx = p.lastIndexOf(segment);
		if (idx > bestIndex) {
			bestIndex = idx;
			best = agent;
		}
	}
	return best;
}

// Pane foreground command → agent. Exact-match against the known binary names
// (mirrors the old CLAUDE_COMMANDS set in bootScan.ts) so look-alikes such as
// `claudette` or `my-codex-wrapper` never classify as an agent pane.
const AGENT_COMMANDS = new Map<string, Agent>([
	['claude', 'claude'],
	['claude.exe', 'claude'],
	['codex', 'codex'],
	['codex.exe', 'codex']
]);

export function agentForCommand(cmd: string): Agent | null {
	return AGENT_COMMANDS.get(cmd) ?? null;
}
