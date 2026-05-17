import { test, expect } from 'bun:test';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { tailTruncate, summarize, type SpawnFn } from './summarize';

test('tailTruncate returns input unchanged when shorter than maxChars', () => {
	expect(tailTruncate('short', 400)).toBe('short');
});

test('tailTruncate returns input unchanged when exactly at maxChars', () => {
	const text = 'a'.repeat(400);
	expect(tailTruncate(text, 400)).toBe(text);
});

test('tailTruncate keeps at most maxChars from the tail', () => {
	const text = 'a'.repeat(1000);
	const result = tailTruncate(text, 400);
	expect(result.length).toBeLessThanOrEqual(400);
});

test('tailTruncate cuts to the next newline boundary after the tail start', () => {
	// 500 chars: 250 lead, newline, 250 trail
	const text = 'X'.repeat(250) + '\n' + 'Y'.repeat(250);
	const result = tailTruncate(text, 300);
	// Tail starts at position 200 (text.length - 300 = 200), inside the X block.
	// Next newline is at position 250, so we cut after it.
	expect(result).toBe('Y'.repeat(250));
});

test('tailTruncate returns the raw tail when no newline exists in it', () => {
	const text = 'A'.repeat(1000); // no newlines anywhere
	const result = tailTruncate(text, 400);
	expect(result).toBe('A'.repeat(400));
});

// Build a minimal stub of node:child_process.ChildProcess that the summarize
// promise reads/writes against. Only the surface summarize() actually touches.
type StubProc = {
	stdin: { write: (data: string) => boolean; end: () => void };
	stdout: Readable;
	stderr: Readable;
	on: EventEmitter['on'];
	emit: EventEmitter['emit'];
	kill: () => void;
};

function makeStubProc(opts: { stdout?: string; stderr?: string }): StubProc {
	const events = new EventEmitter();
	const stdout = Readable.from([opts.stdout ?? '']);
	const stderr = Readable.from([opts.stderr ?? '']);
	return {
		stdin: { write: () => true, end: () => undefined },
		stdout,
		stderr,
		on: events.on.bind(events),
		emit: events.emit.bind(events),
		kill: () => undefined
	};
}

test('summarize resolves with trimmed stdout on exit 0', async () => {
	const proc = makeStubProc({ stdout: '  "approve git push?"  \n' });
	const fakeSpawn: SpawnFn = (() => {
		// Defer the exit emission so the .on('exit', ...) handler is attached first.
		setImmediate(() => proc.emit('exit', 0));
		return proc as unknown as ReturnType<SpawnFn>;
	}) as SpawnFn;

	const result = await summarize('build complete', fakeSpawn);
	expect(result).toBe('approve git push?');
});

test('summarize resolves to null on non-zero exit', async () => {
	const proc = makeStubProc({ stderr: 'auth failed\n' });
	const fakeSpawn: SpawnFn = (() => {
		setImmediate(() => proc.emit('exit', 1));
		return proc as unknown as ReturnType<SpawnFn>;
	}) as SpawnFn;

	const result = await summarize('anything', fakeSpawn);
	expect(result).toBeNull();
});

test('summarize resolves to null on spawn error (e.g., ENOENT)', async () => {
	const proc = makeStubProc({});
	const fakeSpawn: SpawnFn = (() => {
		setImmediate(() => proc.emit('error', new Error('spawn claude ENOENT')));
		return proc as unknown as ReturnType<SpawnFn>;
	}) as SpawnFn;

	const result = await summarize('anything', fakeSpawn);
	expect(result).toBeNull();
});

test('summarize resolves to null when stdout is empty after trimming', async () => {
	const proc = makeStubProc({ stdout: '   \n  ' });
	const fakeSpawn: SpawnFn = (() => {
		setImmediate(() => proc.emit('exit', 0));
		return proc as unknown as ReturnType<SpawnFn>;
	}) as SpawnFn;

	const result = await summarize('anything', fakeSpawn);
	expect(result).toBeNull();
});

test('summarize strips surrounding quotes from the output', async () => {
	const proc = makeStubProc({ stdout: '"tests passed"\n' });
	const fakeSpawn: SpawnFn = (() => {
		setImmediate(() => proc.emit('exit', 0));
		return proc as unknown as ReturnType<SpawnFn>;
	}) as SpawnFn;

	const result = await summarize('anything', fakeSpawn);
	expect(result).toBe('tests passed');
});
