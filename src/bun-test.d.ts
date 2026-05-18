// Minimal ambient declaration so svelte-check accepts the test files without
// having to install @types/bun. The runtime types come from Bun itself when
// `bun test` runs; this file exists only for compile-time checking.
declare module 'bun:test' {
	type TestFn = () => void | Promise<void>;
	export const test: (name: string, fn: TestFn) => void;
	export const beforeEach: (fn: TestFn) => void;
	export const afterEach: (fn: TestFn) => void;

	interface Matchers {
		toBe(expected: unknown): void;
		toBeNull(): void;
		toBeDefined(): void;
		toBeUndefined(): void;
		toBeLessThanOrEqual(expected: number): void;
		toBeGreaterThanOrEqual(expected: number): void;
		toBeInstanceOf(expected: unknown): void;
		toContain(expected: unknown): void;
		toEqual(expected: unknown): void;
		toThrow(): void;
		not: Matchers;
	}
	export function expect(actual: unknown): Matchers;
}
