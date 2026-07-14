// Minimal ambient declaration so svelte-check accepts `bun:sqlite` imports in
// test files (codex state-db fixture creation) without installing @types/bun.
// The runtime module comes from Bun itself under `bun test`. Production code
// never imports the specifier statically — transcript.ts reaches it through a
// computed dynamic import so neither Node nor vite tries to resolve it.
declare module 'bun:sqlite' {
	export class Database {
		constructor(path: string, options?: { readonly?: boolean; create?: boolean });
		prepare(sql: string): {
			get(...params: unknown[]): unknown;
			run(...params: unknown[]): unknown;
		};
		run(sql: string): void;
		close(): void;
	}
}
