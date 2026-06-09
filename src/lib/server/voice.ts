import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Built-in /voice backend (speech-to-prompt). This module holds the daemon-side
// state and policy the start/stop/cancel routes share: the tap version floor and
// its check, the stop-debounce floor, and the per-pane active-recording map.

// /voice tap mode requires Claude Code >= this version. Tap was added in 2.1.116;
// on older CC, arming tap mode persistently does nothing and an injected Space
// would type a literal space instead of toggling dictation. The /voice backend
// enforces this floor (best-effort — see checkVoiceTapVersion).
export const VOICE_TAP_MIN_VERSION = '2.1.116';

// Claude Code debounces a stop tap that lands within ~2s of the start tap, so the
// stop route never fires Space instantly: if the user released early it waits until
// at least this many ms have elapsed since start. A small margin over the observed
// ~2s debounce. Real dictations run longer, so this rarely adds any wait.
export const VOICE_STOP_FLOOR_MS = 2200;

// Parse "2.1.154 (Claude Code)" → [2, 1, 154]. Returns null when the leading token
// isn't a 3-part dotted numeric version. Pure for unit-testing.
export function parseClaudeVersion(stdout: string): [number, number, number] | null {
	const token = stdout.trim().split(/\s+/)[0] ?? '';
	const parts = token.split('.');
	if (parts.length < 3) return null;
	const nums = parts.slice(0, 3).map((p) => Number(p));
	if (nums.some((n) => !Number.isInteger(n) || n < 0)) return null;
	return [nums[0], nums[1], nums[2]];
}

// True iff `version` >= `minimum`, compared major.minor.patch. Unparseable input on
// either side → false (fail closed). Pure.
export function versionGte(version: string, minimum: string): boolean {
	const v = parseClaudeVersion(version);
	const m = parseClaudeVersion(minimum);
	if (!v || !m) return false;
	for (let i = 0; i < 3; i++) {
		if (v[i] !== m[i]) return v[i] > m[i];
	}
	return true;
}

export type VoiceVersionStatus = 'ok' | 'too-old' | 'unknown';

// Definitive results (ok / too-old) are cached for the process — the daemon's
// claude binary doesn't change mid-run. 'unknown' is deliberately NOT cached so a
// transient PATH/exec hiccup is retried on the next call.
let cachedStatus: 'ok' | 'too-old' | null = null;

// Best-effort enforcement of the tap version floor. Resolves the daemon's `claude
// --version` once and compares to VOICE_TAP_MIN_VERSION. The start route refuses on
// 'too-old' and proceeds-with-warning on 'unknown' (can't confirm, but the feature
// may still work and a hard block on an unresolvable version is worse than a warn).
export async function checkVoiceTapVersion(): Promise<VoiceVersionStatus> {
	if (cachedStatus) return cachedStatus;
	let stdout: string;
	try {
		({ stdout } = await execFileAsync('claude', ['--version']));
	} catch {
		return 'unknown';
	}
	if (!parseClaudeVersion(stdout)) return 'unknown';
	cachedStatus = versionGte(stdout, VOICE_TAP_MIN_VERSION) ? 'ok' : 'too-old';
	return cachedStatus;
}

// ─── Active /voice recording state (per pane) ───────────────────────────────
// Module-scoped so the separate start/stop/cancel route modules share it within
// the one daemon process. Keyed by tmux pane id — the injection target.

type ActiveVoice = { startedAt: number };
const active = new Map<string, ActiveVoice>();

export function markVoiceStart(pane: string, now: number = Date.now()): void {
	active.set(pane, { startedAt: now });
}

// ms since the start tap for this pane, or null if no recording is active.
export function voiceElapsedMs(pane: string, now: number = Date.now()): number | null {
	const s = active.get(pane);
	return s ? now - s.startedAt : null;
}

export function clearVoice(pane: string): void {
	active.delete(pane);
}

// How long the stop route must wait before sending the stop Space to clear the
// debounce floor, given ms elapsed since start (null = no active recording → no
// wait). Never negative. Pure for unit-testing.
export function stopWaitMs(elapsedMs: number | null, floor: number = VOICE_STOP_FLOOR_MS): number {
	if (elapsedMs === null) return 0;
	return Math.max(0, floor - elapsedMs);
}
