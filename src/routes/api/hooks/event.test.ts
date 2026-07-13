import { test, expect } from 'bun:test';
import type { RequestEvent } from '@sveltejs/kit';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { POST } from './event/+server';
import {
	getCachedTitle,
	setCachedTitle,
	deleteSessionTopic,
	list,
	remove,
	upsert,
	shouldRefresh
} from '$lib/ticketStore';
import { whimsicalName } from '$lib/whimsicalName';
import { loadSessions } from '$lib/server/sessionsStore';
import { setCorrelationDepsForTest, type CorrelationDeps } from '$lib/server/sshCorrelation';
import type { PaneRow } from '$lib/server/bootScan';

// Unique session_id per test so module-level state doesn't leak.
let testCounter = 0;
const nextId = (): string => `hook-test-${++testCounter}`;

function makeRequest(payload: unknown): RequestEvent {
	const request = new Request('http://localhost/api/hooks/event', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(payload)
	});
	return { request } as unknown as RequestEvent;
}

async function callHandler(payload: unknown): Promise<{ status: number; body: unknown }> {
	const response = await POST(makeRequest(payload));
	return { status: response.status, body: await response.json() };
}

test('UserPromptSubmit increments the session counter', async () => {
	const id = nextId();
	await callHandler({ hook_event_name: 'UserPromptSubmit', session_id: id });
	expect(shouldRefresh(id, 1)).toBe(true); // counter is 1, 1 % 1 === 0
	deleteSessionTopic(id);
});

test('UserPromptSubmit with a failing transcript read keeps the cache empty', async () => {
	const id = nextId();
	// UserPromptSubmit now triggers maybeRefreshTopic directly. With a bad
	// transcript_path the read fails, summarize never runs, and setCachedTitle
	// is not called — cache stays empty across repeated hits.
	for (let i = 0; i < 4; i++) {
		await callHandler({
			hook_event_name: 'UserPromptSubmit',
			session_id: id,
			transcript_path: '/nonexistent/path'
		});
	}
	expect(getCachedTitle(id)).toBe('');
	deleteSessionTopic(id);
});

test('PostToolUse does not increment the counter (would over-trigger)', async () => {
	const id = nextId();
	await callHandler({ hook_event_name: 'PostToolUse', session_id: id });
	// PostToolUse routes through CLEAR_EVENTS and returns before shouldRefresh
	// is reached in production; assert the cache stayed empty as a side-effect
	// check that no summarize ran.
	expect(getCachedTitle(id)).toBe('');
});

test('PostToolUseFailure does not increment the counter', async () => {
	const id = nextId();
	await callHandler({ hook_event_name: 'PostToolUseFailure', session_id: id });
	expect(getCachedTitle(id)).toBe('');
});

test('Stop with a cached title upserts a ticket carrying that title', async () => {
	const id = nextId();
	setCachedTitle(id, 'refactored aggregator');
	const result = await callHandler({
		hook_event_name: 'Stop',
		session_id: id,
		tmux_pane: '%1',
		cwd: '/tmp/proj'
	});
	expect(result.status).toBe(200);
	const ticket = list().find((t) => t.session_id === id);
	expect(ticket?.title).toBe('refactored aggregator');
	expect(ticket?.event_type).toBe('Stop');
	remove(id);
	deleteSessionTopic(id);
});

// Chat-title is the default title_source; with no cached title the upsert path
// falls back to a deterministic whimsical name so the ticket never renders blank.
test('Stop with no cached title falls back to a deterministic whimsical name (chat-title default)', async () => {
	const id = nextId();
	const result = await callHandler({
		hook_event_name: 'Stop',
		session_id: id,
		tmux_pane: '%1',
		cwd: '/tmp/proj'
	});
	expect(result.status).toBe(200);
	const ticket = list().find((t) => t.session_id === id);
	expect(ticket?.title).toBe(whimsicalName(id));
	remove(id);
});

// A real cached title (mimicking either a custom-title pulled from JSONL or a
// haiku summary) wins over the whimsical fallback.
test('A real cached title wins over the whimsical fallback', async () => {
	const id = nextId();
	setCachedTitle(id, 'rename auth module');
	await callHandler({
		hook_event_name: 'Stop',
		session_id: id,
		tmux_pane: '%1',
		cwd: '/tmp/proj'
	});
	const ticket = list().find((t) => t.session_id === id);
	expect(ticket?.title).toBe('rename auth module');
	expect(ticket?.title).not.toBe(whimsicalName(id));
	remove(id);
	deleteSessionTopic(id);
});

test('PermissionRequest carries the cached title and the right event_type', async () => {
	const id = nextId();
	setCachedTitle(id, 'allow rm node_modules?');
	await callHandler({
		hook_event_name: 'PermissionRequest',
		session_id: id,
		tmux_pane: '%1',
		cwd: '/tmp/proj'
	});
	const ticket = list().find((t) => t.session_id === id);
	expect(ticket?.title).toBe('allow rm node_modules?');
	expect(ticket?.event_type).toBe('PermissionRequest');
	remove(id);
	deleteSessionTopic(id);
});

test('SessionEnd clears the per-session topic state and removes any ticket', async () => {
	const id = nextId();
	// Stage some state.
	setCachedTitle(id, 'will be wiped');
	await callHandler({
		hook_event_name: 'Stop',
		session_id: id,
		tmux_pane: '%1',
		cwd: '/tmp/proj'
	});
	expect(list().find((t) => t.session_id === id)).toBeDefined();
	expect(getCachedTitle(id)).toBe('will be wiped');

	const result = await callHandler({ hook_event_name: 'SessionEnd', session_id: id });

	expect((result.body as { action?: string }).action).toBe('cleared');
	expect(list().find((t) => t.session_id === id)).toBeUndefined();
	expect(getCachedTitle(id)).toBe('');
});

test('UserPromptSubmit marks an existing ticket working instead of removing it', async () => {
	const id = nextId();
	await callHandler({
		hook_event_name: 'Stop',
		session_id: id,
		tmux_pane: '%1',
		cwd: '/tmp/proj'
	});
	expect(list().find((t) => t.session_id === id)?.working).toBe(false);

	const result = await callHandler({ hook_event_name: 'UserPromptSubmit', session_id: id });
	expect((result.body as { action?: string }).action).toBe('marked_working');

	const t = list().find((t) => t.session_id === id);
	expect(t).toBeDefined();
	expect(t?.working).toBe(true);
	remove(id);
	deleteSessionTopic(id);
});

test('PostToolUse marks an existing ticket working', async () => {
	const id = nextId();
	await callHandler({
		hook_event_name: 'Stop',
		session_id: id,
		tmux_pane: '%1',
		cwd: '/tmp/proj'
	});
	const result = await callHandler({ hook_event_name: 'PostToolUse', session_id: id });
	expect((result.body as { action?: string }).action).toBe('marked_working');
	expect(list().find((t) => t.session_id === id)?.working).toBe(true);
	remove(id);
});

test('PostToolUseFailure marks an existing ticket working', async () => {
	const id = nextId();
	await callHandler({
		hook_event_name: 'Stop',
		session_id: id,
		tmux_pane: '%1',
		cwd: '/tmp/proj'
	});
	const result = await callHandler({ hook_event_name: 'PostToolUseFailure', session_id: id });
	expect((result.body as { action?: string }).action).toBe('marked_working');
	expect(list().find((t) => t.session_id === id)?.working).toBe(true);
	remove(id);
});

test('A Stop after UserPromptSubmit lifts the working ticket back to idle', async () => {
	const id = nextId();
	await callHandler({
		hook_event_name: 'Stop',
		session_id: id,
		tmux_pane: '%1',
		cwd: '/tmp/proj'
	});
	await callHandler({ hook_event_name: 'UserPromptSubmit', session_id: id });
	expect(list().find((t) => t.session_id === id)?.working).toBe(true);

	await callHandler({
		hook_event_name: 'Stop',
		session_id: id,
		tmux_pane: '%1',
		cwd: '/tmp/proj'
	});
	const t = list().find((t) => t.session_id === id);
	expect(t?.working).toBe(false);
	expect(t?.event_type).toBe('Stop');
	remove(id);
	deleteSessionTopic(id);
});

test('missing hook_event_name returns 400', async () => {
	const result = await callHandler({ session_id: nextId() });
	expect(result.status).toBe(400);
});

test('missing session_id returns 400', async () => {
	const result = await callHandler({ hook_event_name: 'Stop' });
	expect(result.status).toBe(400);
});

test('Stop without tmux_pane returns 400', async () => {
	const result = await callHandler({
		hook_event_name: 'Stop',
		session_id: nextId()
	});
	expect(result.status).toBe(400);
});

test('unknown hook event returns 200 with action="ignored"', async () => {
	const result = await callHandler({
		hook_event_name: 'NotARealEvent',
		session_id: nextId(),
		tmux_pane: '%1'
	});
	expect(result.status).toBe(200);
	expect((result.body as { action?: string }).action).toBe('ignored');
});

test('invalid JSON body returns 400', async () => {
	const request = new Request('http://localhost/api/hooks/event', {
		method: 'POST',
		body: 'not json'
	});
	const response = await POST({ request } as unknown as RequestEvent);
	expect(response.status).toBe(400);
});

// Integration: PermissionRequest kicks off the decline watcher, and a denial
// line appended to the real transcript file lifts the ticket back to a
// Stop+idle resting state via resolveDeclineIfMatch (declined permission is
// resolved, not still working). The transcript path must live under ~/.claude/
// to pass the watcher's containment check. Cleanup runs after the assertions
// so the watcher's cancel (on detection) lands before unlink.
test('PermissionRequest + appended denial line lifts the ticket to Stop+idle via the watcher', async () => {
	const tempDir = mkdtempSync(path.join(os.homedir(), '.claude', '.expediter-test-'));
	const tempFile = path.join(tempDir, 'transcript.jsonl');
	writeFileSync(tempFile, '');

	const id = nextId();
	const result = await callHandler({
		hook_event_name: 'PermissionRequest',
		session_id: id,
		tmux_pane: '%1',
		cwd: '/tmp/proj',
		transcript_path: tempFile
	});
	expect(result.status).toBe(200);
	expect(list().find((t) => t.session_id === id)?.event_type).toBe('PermissionRequest');

	// Give the watcher's async start block time to capture the starting offset
	// and attach fs.watch before we append.
	await new Promise((r) => setTimeout(r, 80));

	const denialLine =
		JSON.stringify({
			type: 'user',
			message: {
				content: [
					{
						type: 'tool_result',
						is_error: true,
						content: "The user doesn't want to proceed with this tool use."
					}
				]
			}
		}) + '\n';
	appendFileSync(tempFile, denialLine);

	const start = Date.now();
	while (Date.now() - start < 700) {
		if (list().find((t) => t.session_id === id)?.event_type === 'Stop') break;
		await new Promise((r) => setTimeout(r, 20));
	}

	const t = list().find((t) => t.session_id === id);
	expect(t).toBeDefined();
	expect(t?.event_type).toBe('Stop');
	expect(t?.working).toBe(false);

	rmSync(tempDir, { recursive: true, force: true });
	remove(id);
	deleteSessionTopic(id);
});

// A subsequent event for the same session_id must cancel the decline watcher.
// Otherwise an approved (not declined) PermissionRequest leaks a 1h watcher.
// We verify this by posting a PR + a follow-up event, then appending a denial
// line — the cancelled watcher should not fire, so the ticket's event_type
// stays at whatever the follow-up set it to instead of being lifted to Stop.
test('A subsequent event cancels the decline watcher (approve case)', async () => {
	const tempDir = mkdtempSync(path.join(os.homedir(), '.claude', '.expediter-test-'));
	const tempFile = path.join(tempDir, 'transcript.jsonl');
	writeFileSync(tempFile, '');

	const id = nextId();
	await callHandler({
		hook_event_name: 'PermissionRequest',
		session_id: id,
		tmux_pane: '%1',
		cwd: '/tmp/proj',
		transcript_path: tempFile
	});

	// Wait for the watcher to attach before superseding it.
	await new Promise((r) => setTimeout(r, 80));

	// Approve-then-process is signalled by PostToolUse — this should cancel the
	// PR's decline watcher.
	const followUp = await callHandler({ hook_event_name: 'PostToolUse', session_id: id });
	expect((followUp.body as { action?: string }).action).toBe('marked_working');

	// Now append a denial line that the (cancelled) watcher would otherwise
	// detect. After waiting, the ticket must still be in the post-follow-up
	// state — not lifted to Stop by a stale watcher.
	appendFileSync(
		tempFile,
		JSON.stringify({
			type: 'user',
			message: {
				content: [
					{
						type: 'tool_result',
						is_error: true,
						content: "The user doesn't want to proceed with this tool use."
					}
				]
			}
		}) + '\n'
	);
	await new Promise((r) => setTimeout(r, 250));

	const t = list().find((t) => t.session_id === id);
	expect(t).toBeDefined();
	expect(t?.event_type).toBe('PermissionRequest');
	expect(t?.working).toBe(true);

	rmSync(tempDir, { recursive: true, force: true });
	remove(id);
	deleteSessionTopic(id);
});

// SessionStart wiring: payload must upsert an Idle ticket AND persist the
// session via recordSession. The temp sessions.json is selected via the
// EXPEDITER_SESSIONS_FILE env var (read on every call by sessionsStore.ts),
// and the temp transcript lives under ~/.claude/ to satisfy
// latestCustomTitle's containment check.
test('SessionStart upserts an Idle ticket and records the session to sessions.json', async () => {
	const sessionsDir = mkdtempSync(path.join(os.tmpdir(), 'expediter-sessions-'));
	const sessionsFile = path.join(sessionsDir, 'sessions.json');
	process.env.EXPEDITER_SESSIONS_FILE = sessionsFile;

	const transcriptDir = mkdtempSync(path.join(os.homedir(), '.claude', '.expediter-test-'));
	const transcriptFile = path.join(transcriptDir, 'transcript.jsonl');
	writeFileSync(transcriptFile, '');

	const id = nextId();
	const result = await callHandler({
		hook_event_name: 'SessionStart',
		session_id: id,
		tmux_pane: '%55',
		cwd: '/tmp/proj',
		transcript_path: transcriptFile
	});
	expect(result.status).toBe(200);
	expect((result.body as { action?: string }).action).toBe('session_started');

	const ticket = list().find((t) => t.session_id === id);
	expect(ticket?.event_type).toBe('Idle');
	expect(ticket?.tmux_pane).toBe('%55');

	// recordSession is fire-and-forget; give it a tick to land on disk.
	await new Promise((r) => setTimeout(r, 50));
	const persisted = await loadSessions();
	expect(persisted[id]).toBeDefined();
	expect(persisted[id]?.tmux_pane).toBe('%55');
	expect(persisted[id]?.cwd).toBe('/tmp/proj');

	delete process.env.EXPEDITER_SESSIONS_FILE;
	rmSync(sessionsDir, { recursive: true, force: true });
	rmSync(transcriptDir, { recursive: true, force: true });
	remove(id);
	deleteSessionTopic(id);
});

test('SessionStart removes a pending:<pane> placeholder before upserting the real ticket', async () => {
	const sessionsDir = mkdtempSync(path.join(os.tmpdir(), 'expediter-sessions-'));
	process.env.EXPEDITER_SESSIONS_FILE = path.join(sessionsDir, 'sessions.json');
	const transcriptDir = mkdtempSync(path.join(os.homedir(), '.claude', '.expediter-test-'));
	const transcriptFile = path.join(transcriptDir, 'transcript.jsonl');
	writeFileSync(transcriptFile, '');

	// Seed a placeholder for pane %77 — as the boot scan would have.
	upsert({
		session_id: 'pending:%77',
		tmux_pane: '%77',
		cwd: '/tmp/proj',
		title: 'forgotten lighthouse',
		event_type: 'Idle',
		created_at: Date.now()
	});
	expect(list().find((t) => t.session_id === 'pending:%77')).toBeDefined();

	const id = nextId();
	await callHandler({
		hook_event_name: 'SessionStart',
		session_id: id,
		tmux_pane: '%77',
		cwd: '/tmp/proj',
		transcript_path: transcriptFile
	});

	expect(list().find((t) => t.session_id === 'pending:%77')).toBeUndefined();
	expect(list().find((t) => t.session_id === id)?.event_type).toBe('Idle');

	delete process.env.EXPEDITER_SESSIONS_FILE;
	rmSync(sessionsDir, { recursive: true, force: true });
	rmSync(transcriptDir, { recursive: true, force: true });
	remove(id);
	deleteSessionTopic(id);
});

test('SessionStart without tmux_pane returns 400', async () => {
	const result = await callHandler({
		hook_event_name: 'SessionStart',
		session_id: nextId(),
		transcript_path: '/tmp/whatever'
	});
	expect(result.status).toBe(400);
});

test('SessionEnd calls forgetSession (entry removed from sessions.json)', async () => {
	const sessionsDir = mkdtempSync(path.join(os.tmpdir(), 'expediter-sessions-'));
	const sessionsFile = path.join(sessionsDir, 'sessions.json');
	process.env.EXPEDITER_SESSIONS_FILE = sessionsFile;
	const transcriptDir = mkdtempSync(path.join(os.homedir(), '.claude', '.expediter-test-'));
	const transcriptFile = path.join(transcriptDir, 'transcript.jsonl');
	writeFileSync(transcriptFile, '');

	const id = nextId();
	// Stage: SessionStart writes the entry.
	await callHandler({
		hook_event_name: 'SessionStart',
		session_id: id,
		tmux_pane: '%88',
		cwd: '/tmp/proj',
		transcript_path: transcriptFile
	});
	await new Promise((r) => setTimeout(r, 50));
	expect((await loadSessions())[id]).toBeDefined();

	// SessionEnd should remove it.
	await callHandler({ hook_event_name: 'SessionEnd', session_id: id });
	await new Promise((r) => setTimeout(r, 50));
	expect((await loadSessions())[id]).toBeUndefined();

	delete process.env.EXPEDITER_SESSIONS_FILE;
	rmSync(sessionsDir, { recursive: true, force: true });
	rmSync(transcriptDir, { recursive: true, force: true });
	deleteSessionTopic(id);
});

// Core repro for the "ticket stays grey / working never engages" bug: the
// pane's ticket is keyed by a stale session_id (boot-scan/metadata key that
// diverged from the live session after a rewind). UserPromptSubmit must rebind
// it to the live session_id so markWorking lands on the first message.
test('UserPromptSubmit rebinds a stale-keyed pane ticket and marks it working', async () => {
	upsert({
		session_id: 'old-sid',
		tmux_pane: '%7',
		cwd: '/proj',
		title: 'my-session',
		event_type: 'Idle',
		created_at: Date.now()
	});

	const result = await callHandler({
		hook_event_name: 'UserPromptSubmit',
		session_id: 'live-sid',
		tmux_pane: '%7'
	});
	expect((result.body as { action?: string }).action).toBe('marked_working');

	const t = list().find((x) => x.tmux_pane === '%7');
	expect(t?.session_id).toBe('live-sid');
	expect(t?.working).toBe(true);
	expect(t?.title).toBe('my-session');
	expect(list().find((x) => x.session_id === 'old-sid')).toBeUndefined();
	remove('live-sid');
	deleteSessionTopic('live-sid');
});

test('Stop on a pane with a stale-keyed ticket leaves a single ticket under the live session_id', async () => {
	upsert({
		session_id: 'old-sid-2',
		tmux_pane: '%17',
		cwd: '/proj',
		title: 'whatever',
		event_type: 'Idle',
		created_at: Date.now()
	});

	await callHandler({
		hook_event_name: 'Stop',
		session_id: 'live-sid-2',
		tmux_pane: '%17',
		cwd: '/proj'
	});

	const paneTickets = list().filter((t) => t.tmux_pane === '%17');
	expect(paneTickets.length).toBe(1);
	expect(paneTickets[0].session_id).toBe('live-sid-2');
	expect(paneTickets[0].event_type).toBe('Stop');
	remove('live-sid-2');
	deleteSessionTopic('live-sid-2');
});

test('Stop on a pane with a placeholder removes the placeholder first', async () => {
	// Seed a placeholder for pane %33 — boot-scan equivalent.
	upsert({
		session_id: 'pending:%33',
		tmux_pane: '%33',
		cwd: '/tmp/proj',
		title: 'forgotten lighthouse',
		event_type: 'Idle',
		created_at: Date.now()
	});
	expect(list().find((t) => t.session_id === 'pending:%33')).toBeDefined();

	// A real session_id arrives via Stop (a pre-existing unnamed session's
	// first interaction post-daemon-boot).
	const id = nextId();
	await callHandler({
		hook_event_name: 'Stop',
		session_id: id,
		tmux_pane: '%33',
		cwd: '/tmp/proj'
	});

	expect(list().find((t) => t.session_id === 'pending:%33')).toBeUndefined();
	expect(list().find((t) => t.session_id === id)?.event_type).toBe('Stop');

	remove(id);
	deleteSessionTopic(id);
});

// ─── remote sessions ────────────────────────────────────────────────────────

// Stubbed correlation deps: one local pane %9 (shell pid 900) owning an ssh
// client (pid 450) whose local port matches the SSH_CONNECTION below. The
// setCorrelationDepsForTest seam is reset after each remote test.
const REMOTE_CONN = '100.64.0.7 52814 10.1.2.3 22';

function remotePane(pane_id: string, pane_pid: number, cmd = 'zsh'): PaneRow {
	return {
		pane_id,
		pane_pid,
		pane_current_command: cmd,
		pane_current_path: '/',
		session_attached: true
	};
}

function stubCorrelation(overrides: Partial<CorrelationDeps> = {}): void {
	setCorrelationDepsForTest({
		loadSessions: async () => ({}),
		listPanes: async () => [remotePane('%9', 900)],
		lsofEstablishedPids: async () => [450],
		processCommand: async () => 'ssh',
		parentPid: async (pid) => (pid === 450 ? 900 : null),
		...overrides
	});
}

function useTempSessionsFileForRemote(): { dir: string; done: () => void } {
	const dir = mkdtempSync(path.join(os.tmpdir(), 'expediter-remote-'));
	process.env.EXPEDITER_SESSIONS_FILE = path.join(dir, 'sessions.json');
	return {
		dir,
		done: () => {
			delete process.env.EXPEDITER_SESSIONS_FILE;
			rmSync(dir, { recursive: true, force: true });
		}
	};
}

// A remote SessionStart correlates the pane, upserts a remote ticket carrying
// the payload title, and persists remote+title to sessions.json for reseed.
test('remote SessionStart resolves the pane and upserts a remote ticket with the payload title', async () => {
	const temp = useTempSessionsFileForRemote();
	stubCorrelation();

	const id = nextId();
	const result = await callHandler({
		hook_event_name: 'SessionStart',
		session_id: id,
		remote: true,
		ssh_connection: REMOTE_CONN,
		cwd: '/remote/home/user/proj',
		transcript_path: '/remote/home/user/.claude/projects/x/t.jsonl',
		title: 'gpu box refactor'
	});
	expect(result.status).toBe(200);

	const ticket = list().find((t) => t.session_id === id);
	expect(ticket?.tmux_pane).toBe('%9');
	expect(ticket?.remote).toBe(true);
	expect(ticket?.event_type).toBe('Idle');
	expect(ticket?.title).toBe('gpu box refactor');

	await new Promise((r) => setTimeout(r, 50));
	const persisted = await loadSessions();
	expect(persisted[id]?.remote).toBe(true);
	expect(persisted[id]?.title).toBe('gpu box refactor');
	expect(persisted[id]?.tmux_pane).toBe('%9');

	setCorrelationDepsForTest(null);
	temp.done();
	remove(id);
	deleteSessionTopic(id);
});

// Decision 10: correlation failure is a loud 422 and no ticket — never an
// unfocusable ticket.
test('remote event with failed correlation returns 422 and creates no ticket', async () => {
	const temp = useTempSessionsFileForRemote();
	stubCorrelation({ lsofEstablishedPids: async () => [] }); // walk dead-ends at lsof

	const id = nextId();
	const result = await callHandler({
		hook_event_name: 'Stop',
		session_id: id,
		remote: true,
		ssh_connection: REMOTE_CONN,
		cwd: '/remote/proj'
	});
	expect(result.status).toBe(422);
	expect(String((result.body as { error?: string }).error)).toContain('lsof');
	expect(list().find((t) => t.session_id === id)).toBeUndefined();

	setCorrelationDepsForTest(null);
	temp.done();
});

// remote:true with NEITHER identifier falls through to the existing 400, not
// a correlation attempt (checklist 1.4).
test('remote event with neither ssh_connection nor tmux_pane returns 400', async () => {
	const result = await callHandler({
		hook_event_name: 'Stop',
		session_id: nextId(),
		remote: true,
		cwd: '/remote/proj'
	});
	expect(result.status).toBe(400);
});

// Decision 7: the payload title is cached and preferred over the whimsical
// fallback, and persists across subsequent title-less events for the session.
test('remote payload title is cached and preferred over the whimsical fallback', async () => {
	const temp = useTempSessionsFileForRemote();
	stubCorrelation();

	const id = nextId();
	await callHandler({
		hook_event_name: 'Stop',
		session_id: id,
		remote: true,
		ssh_connection: REMOTE_CONN,
		cwd: '/remote/proj',
		title: 'tunnel debugging'
	});
	expect(getCachedTitle(id)).toBe('tunnel debugging');
	expect(list().find((t) => t.session_id === id)?.title).toBe('tunnel debugging');

	// A later event without a title keeps the cached one.
	await callHandler({
		hook_event_name: 'PermissionRequest',
		session_id: id,
		remote: true,
		ssh_connection: REMOTE_CONN,
		cwd: '/remote/proj'
	});
	const ticket = list().find((t) => t.session_id === id);
	expect(ticket?.title).toBe('tunnel debugging');
	expect(ticket?.title).not.toBe(whimsicalName(id));

	setCorrelationDepsForTest(null);
	temp.done();
	remove(id);
	deleteSessionTopic(id);
});

// A remote title change mid-session (e.g. /rename on the far side) updates the
// persisted sessions.json title so a daemon restart reseeds the new name
// (decision 13).
test('a changed remote payload title updates the persisted session title', async () => {
	const temp = useTempSessionsFileForRemote();
	stubCorrelation();

	const id = nextId();
	await callHandler({
		hook_event_name: 'SessionStart',
		session_id: id,
		remote: true,
		ssh_connection: REMOTE_CONN,
		cwd: '/remote/proj',
		transcript_path: '/remote/.claude/t.jsonl',
		title: 'first name'
	});
	await callHandler({
		hook_event_name: 'Stop',
		session_id: id,
		remote: true,
		ssh_connection: REMOTE_CONN,
		cwd: '/remote/proj',
		title: 'renamed session'
	});

	await new Promise((r) => setTimeout(r, 50));
	expect((await loadSessions())[id]?.title).toBe('renamed session');

	setCorrelationDepsForTest(null);
	temp.done();
	remove(id);
	deleteSessionTopic(id);
});

// Decision 9: local transcript reads are gated off for remote sessions. The
// transcript here is deliberately a READABLE local file with a custom-title
// line — if the SessionStart pre-fill or topic refresh ran anyway, the cache
// would pick up "local leak"; it must stay empty (whimsical ticket).
test('remote SessionStart skips the local transcript pre-fill even for a readable path', async () => {
	const temp = useTempSessionsFileForRemote();
	stubCorrelation();

	const transcriptDir = mkdtempSync(path.join(os.homedir(), '.claude', '.expediter-test-'));
	const transcriptFile = path.join(transcriptDir, 'transcript.jsonl');
	writeFileSync(
		transcriptFile,
		JSON.stringify({ type: 'custom-title', customTitle: 'local leak' }) + '\n'
	);

	const id = nextId();
	await callHandler({
		hook_event_name: 'SessionStart',
		session_id: id,
		remote: true,
		ssh_connection: REMOTE_CONN,
		cwd: '/remote/proj',
		transcript_path: transcriptFile
		// no payload title
	});

	await new Promise((r) => setTimeout(r, 80)); // pre-fill would have landed by now
	expect(getCachedTitle(id)).toBe('');
	expect(list().find((t) => t.session_id === id)?.title).toBe(whimsicalName(id));

	setCorrelationDepsForTest(null);
	temp.done();
	rmSync(transcriptDir, { recursive: true, force: true });
	remove(id);
	deleteSessionTopic(id);
});

// Remote PermissionRequests get no decline watcher (the real transcript is on
// the far box). A denial line appended to a readable local file at the same
// path must therefore have no effect.
test('remote PermissionRequest spawns no decline watcher', async () => {
	const temp = useTempSessionsFileForRemote();
	stubCorrelation();

	const tempDir = mkdtempSync(path.join(os.homedir(), '.claude', '.expediter-test-'));
	const tempFile = path.join(tempDir, 'transcript.jsonl');
	writeFileSync(tempFile, '');

	const id = nextId();
	await callHandler({
		hook_event_name: 'PermissionRequest',
		session_id: id,
		remote: true,
		ssh_connection: REMOTE_CONN,
		cwd: '/remote/proj',
		transcript_path: tempFile
	});
	expect(list().find((t) => t.session_id === id)?.event_type).toBe('PermissionRequest');

	await new Promise((r) => setTimeout(r, 80));
	appendFileSync(
		tempFile,
		JSON.stringify({
			type: 'user',
			message: {
				content: [
					{
						type: 'tool_result',
						is_error: true,
						content: "The user doesn't want to proceed with this tool use."
					}
				]
			}
		}) + '\n'
	);
	await new Promise((r) => setTimeout(r, 250));

	// Still PermissionRequest — a watcher would have lifted it to Stop.
	expect(list().find((t) => t.session_id === id)?.event_type).toBe('PermissionRequest');

	setCorrelationDepsForTest(null);
	temp.done();
	rmSync(tempDir, { recursive: true, force: true });
	remove(id);
	deleteSessionTopic(id);
});

// The steady-state fast path: after SessionStart records the session, a
// follow-up event resolves through sessions.json + live-pane validation and
// never needs lsof.
test('a follow-up remote event resolves via the sessions.json fast path (no lsof)', async () => {
	const temp = useTempSessionsFileForRemote();
	let lsofCalls = 0;
	// loadSessions dep must be the REAL one so the fast path sees what the
	// handler recorded; only count lsof to prove the slow path stayed cold
	// after the first event.
	const { loadSessions: realLoad } = await import('$lib/server/sessionsStore');
	setCorrelationDepsForTest({
		loadSessions: realLoad,
		listPanes: async () => [remotePane('%9', 900)],
		lsofEstablishedPids: async () => {
			lsofCalls++;
			return [450];
		},
		processCommand: async () => 'ssh',
		parentPid: async (pid) => (pid === 450 ? 900 : null)
	});

	const id = nextId();
	await callHandler({
		hook_event_name: 'SessionStart',
		session_id: id,
		remote: true,
		ssh_connection: REMOTE_CONN,
		cwd: '/remote/proj',
		transcript_path: '/remote/.claude/t.jsonl'
	});
	const afterStart = lsofCalls;

	const followUp = await callHandler({
		hook_event_name: 'UserPromptSubmit',
		session_id: id,
		remote: true,
		ssh_connection: REMOTE_CONN,
		cwd: '/remote/proj'
	});
	expect((followUp.body as { action?: string }).action).toBe('marked_working');
	expect(list().find((t) => t.session_id === id)?.working).toBe(true);
	expect(lsofCalls).toBe(afterStart); // fast path — lsof never ran again

	setCorrelationDepsForTest(null);
	temp.done();
	remove(id);
	deleteSessionTopic(id);
});

// Confirm the wiring is gated to PermissionRequest only: a Stop event for the
// same kind of payload should NOT spawn a watcher, so a later denial line in
// the file should not affect the Stop ticket.
test('Stop does not spawn a watcher (denial line in transcript has no effect)', async () => {
	const tempDir = mkdtempSync(path.join(os.homedir(), '.claude', '.expediter-test-'));
	const tempFile = path.join(tempDir, 'transcript.jsonl');
	writeFileSync(tempFile, '');

	const id = nextId();
	await callHandler({
		hook_event_name: 'Stop',
		session_id: id,
		tmux_pane: '%1',
		cwd: '/tmp/proj',
		transcript_path: tempFile
	});
	expect(list().find((t) => t.session_id === id)).toBeDefined();

	await new Promise((r) => setTimeout(r, 80));
	appendFileSync(
		tempFile,
		JSON.stringify({
			type: 'user',
			message: {
				content: [
					{
						type: 'tool_result',
						is_error: true,
						content: "The user doesn't want to proceed with this tool use."
					}
				]
			}
		}) + '\n'
	);
	await new Promise((r) => setTimeout(r, 200));

	expect(list().find((t) => t.session_id === id)).toBeDefined();

	rmSync(tempDir, { recursive: true, force: true });
	remove(id);
	deleteSessionTopic(id);
});
