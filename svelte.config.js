import adapter from '@sveltejs/adapter-node';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	compilerOptions: {
		// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
		runes: ({ filename }) => (filename.split(/[/\\]/).includes('node_modules') ? undefined : true)
	},
	kit: {
		// adapter-node emits a self-contained server at `build/index.js` that runs
		// under Bun (and Node) — the daemon LaunchAgent invokes `bun ./build/index.js`.
		adapter: adapter({
			out: 'build',
			precompress: false,
			envPrefix: 'EXPEDITER_'
		})
	}
};

export default config;
