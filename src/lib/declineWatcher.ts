import { watch, createReadStream, type FSWatcher } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// Watcher for a single PermissionRequest ticket. Tails the same Claude Code
// transcript JSONL that the hook payload's `transcript_path` points at and
// fires `onDecline` when the user manually declines or interrupts the prompt
// (Claude Code emits no hook event for that path, so a transcript-level
// signal is the only Claude-Code-independent way to detect resolution).

const TRANSCRIPT_ROOT = path.resolve(path.join(os.homedir(), '.claude'));
const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;
const DEBOUNCE_MS = 50;
// Verified verbatim against a captured transcript JSONL for both "Deny" and
// Esc/interrupt on Claude Code v2.1.139. If Claude Code ever changes the
// wording, this watcher silently stops firing and the symptom (stale red
// ticket) returns until the prefix is updated.
const DENIAL_PREFIX = "The user doesn't want to proceed with this tool use";

// Defense-in-depth against a forged hook payload pointing the watcher at an
// arbitrary file. Duplicated from src/lib/transcript.ts to keep that module
// untouched; if a single source-of-truth becomes important, promote to a
// shared helper there.
function isWithinTranscriptRoot(p: string): boolean {
	const resolved = path.resolve(p);
	return resolved === TRANSCRIPT_ROOT || resolved.startsWith(TRANSCRIPT_ROOT + path.sep);
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
			let parsed: TranscriptLine;
			try {
				parsed = JSON.parse(line);
			} catch {
				continue;
			}
			if (lineIsDenial(parsed)) {
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
