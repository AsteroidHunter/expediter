import { watch, createReadStream, type FSWatcher } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { agentForPath } from './agent';
import { DENIAL_PREFIX } from './transcript';

// Watcher for a single PermissionRequest ticket. Tails the transcript the
// hook payload's `transcript_path` points at — Claude Code's JSONL or Codex's
// rollout — and fires `onDecline` when the user manually declines or
// interrupts the prompt (neither agent emits a hook event for that path, so a
// transcript-level signal is the only agent-independent way to detect
// resolution). Local sessions only: the hook server never starts a watcher
// for remote tickets (their transcript lives on the far box).

const TRANSCRIPT_ROOT = path.resolve(path.join(os.homedir(), '.claude'));
const CODEX_TRANSCRIPT_ROOT = path.resolve(path.join(os.homedir(), '.codex'));
const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;
const DEBOUNCE_MS = 50;
// DENIAL_PREFIX (imported from transcript.ts, the single source of truth) is
// verified verbatim on Claude Code v2.1.139. If Claude Code ever changes the
// wording, this watcher silently stops firing and the symptom (stale red
// ticket) returns until the prefix is updated.

// Defense-in-depth against a forged hook payload pointing the watcher at an
// arbitrary file. Duplicated from src/lib/transcript.ts to keep that module
// untouched; if a single source-of-truth becomes important, promote to a
// shared helper there.
function isWithinTranscriptRoot(p: string): boolean {
	const resolved = path.resolve(p);
	for (const root of [TRANSCRIPT_ROOT, CODEX_TRANSCRIPT_ROOT]) {
		if (resolved === root || resolved.startsWith(root + path.sep)) return true;
	}
	return false;
}

type ToolResultBlock = {
	type?: string;
	is_error?: boolean;
	content?: string;
};
type TranscriptLine = {
	type?: string;
	message?: { content?: ToolResultBlock[] | string };
};

function lineIsDenial(parsed: TranscriptLine): boolean {
	if (parsed.type !== 'user') return false;
	const content = parsed.message?.content;
	if (!Array.isArray(content)) return false;
	for (const block of content) {
		if (
			block?.type === 'tool_result' &&
			block.is_error === true &&
			typeof block.content === 'string' &&
			block.content.startsWith(DENIAL_PREFIX)
		) {
			return true;
		}
	}
	return false;
}

// Codex's decline signal is typed, not an English string: a manual decline or
// interrupt appends {"type":"event_msg","payload":{"type":"turn_aborted",
// "reason":"interrupted",…}} to the rollout (shape pinned live on 0.144.1).
// The "aborted by user after Ns" custom_tool_call_output the abort also
// writes is matched as a secondary signal.
type CodexRolloutLine = {
	type?: string;
	payload?: { type?: string; reason?: unknown; output?: unknown };
};

function lineIsCodexDecline(parsed: CodexRolloutLine): boolean {
	const p = parsed.payload;
	if (!p) return false;
	if (parsed.type === 'event_msg' && p.type === 'turn_aborted' && p.reason === 'interrupted') {
		return true;
	}
	if (
		parsed.type === 'response_item' &&
		p.type === 'custom_tool_call_output' &&
		typeof p.output === 'string' &&
		p.output.startsWith('aborted by user')
	) {
		return true;
	}
	return false;
}

async function readSliceFromOffset(filePath: string, offset: number): Promise<string> {
	return new Promise((resolve, reject) => {
		const stream = createReadStream(filePath, { start: offset, encoding: 'utf8' });
		let data = '';
		stream.on('data', (chunk) => {
			data += chunk;
		});
		stream.on('end', () => resolve(data));
		stream.on('error', reject);
	});
}

export type DeclineWatcherOpts = {
	transcriptPath: string;
	sessionId: string;
	createdAt: number;
	onDecline: () => void;
	timeoutMs?: number;
};

// Returns a cancel handle. Idempotent — calling cancel twice is a no-op.
export function watchForDecline(opts: DeclineWatcherOpts): () => void {
	if (!isWithinTranscriptRoot(opts.transcriptPath)) {
		console.warn(`[decline] rejected path outside root: ${opts.transcriptPath}`);
		return () => {};
	}
	// Matcher is selected by the transcript's agent: Claude's denial-string
	// tool_result vs Codex's typed turn_aborted event.
	const lineIsDecline =
		agentForPath(path.resolve(opts.transcriptPath)) === 'codex'
			? lineIsCodexDecline
			: lineIsDenial;

	let cancelled = false;
	let offset = 0;
	let watcher: FSWatcher | null = null;
	let debounceHandle: ReturnType<typeof setTimeout> | null = null;
	let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

	const cancel = (): void => {
		if (cancelled) return;
		cancelled = true;
		if (watcher) {
			try {
				watcher.close();
			} catch {
				/* already closed */
			}
			watcher = null;
		}
		if (debounceHandle !== null) {
			clearTimeout(debounceHandle);
			debounceHandle = null;
		}
		if (timeoutHandle !== null) {
			clearTimeout(timeoutHandle);
			timeoutHandle = null;
		}
	};

	const onChange = (): void => {
		if (cancelled) return;
		if (debounceHandle !== null) clearTimeout(debounceHandle);
		debounceHandle = setTimeout(() => {
			debounceHandle = null;
			if (cancelled) return;
			void processChange();
		}, DEBOUNCE_MS);
		debounceHandle.unref?.();
	};

	const processChange = async (): Promise<void> => {
		let stats: Awaited<ReturnType<typeof stat>>;
		try {
			stats = await stat(opts.transcriptPath);
		} catch {
			return;
		}

		if (stats.size < offset) {
			// File was truncated or rotated. Reset offset to the new end and skip
			// this round — we cannot reliably compare bytes from before the reset.
			console.warn(
				`[decline] transcript shrank for session=${opts.sessionId.slice(0, 8)}; resetting offset`
			);
			offset = stats.size;
			return;
		}

		if (stats.size === offset) return;

		let slice: string;
		try {
			slice = await readSliceFromOffset(opts.transcriptPath, offset);
		} catch {
			return;
		}
		offset = stats.size;

		for (const line of slice.split('\n')) {
			if (!line) continue;
			let parsed: TranscriptLine & CodexRolloutLine;
			try {
				parsed = JSON.parse(line);
			} catch {
				continue;
			}
			if (lineIsDecline(parsed)) {
				cancel();
				opts.onDecline();
				return;
			}
		}
	};

	void (async () => {
		try {
			const stats = await stat(opts.transcriptPath);
			offset = stats.size;
		} catch {
			offset = 0;
		}
		if (cancelled) return;

		try {
			watcher = watch(opts.transcriptPath, { persistent: false }, onChange);
		} catch (err) {
			console.warn('[decline] fs.watch failed:', err);
			return;
		}

		timeoutHandle = setTimeout(() => {
			timeoutHandle = null;
			cancel();
		}, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
		timeoutHandle.unref?.();
	})();

	return cancel;
}
