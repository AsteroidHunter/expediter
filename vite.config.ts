import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import { SvelteKitPWA } from '@vite-pwa/sveltekit';

export default defineConfig({
	// Daemon is deliberately reachable from the tethered phone over the USB
	// network interface; Vite's default host-header allowlist blocks any
	// request whose Host isn't localhost/127.0.0.1 with an empty reply.
	// `allowedHosts: true` disables that check. The daemon is single-user,
	// LAN-bound, and rate-isolated by the cable — no external attack surface.
	server: {
		host: true,
		allowedHosts: true,
		port: 5179
	},
	preview: {
		host: true,
		allowedHosts: true,
		port: 5179
	},
	plugins: [
		sveltekit(),
		SvelteKitPWA({
			registerType: 'autoUpdate',
			manifest: {
				name: 'Expediter',
				short_name: 'Expediter',
				description: 'Attention queue for Claude Code sessions',
				theme_color: '#0a0a0a',
				background_color: '#0a0a0a',
				display: 'standalone',
				orientation: 'portrait',
				start_url: '/',
				icons: [
					{
						src: '/icon-192.png',
						sizes: '192x192',
						type: 'image/png'
					},
					{
						src: '/icon-512.png',
						sizes: '512x512',
						type: 'image/png'
					},
					{
						src: '/icon-512-maskable.png',
						sizes: '512x512',
						type: 'image/png',
						purpose: 'maskable'
					}
				]
			},
			devOptions: {
				enabled: false
			}
		})
	]
});
