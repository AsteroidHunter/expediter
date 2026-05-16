<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { fly } from 'svelte/transition';
	import { flip } from 'svelte/animate';
	import { browser } from '$app/environment';

	type EventType = 'Stop' | 'PermissionRequest' | 'Notification';
	type Ticket = {
		session_id: string;
		tmux_pane: string;
		cwd: string;
		title: string;
		event_type: EventType;
		created_at: number;
	};

	let tickets = $state<Ticket[]>([]);
	let connected = $state(false);
	let focusing = $state<string | null>(null);
	let mockMode = false;

	const mockLoaders = import.meta.glob<{ getMockTickets: () => Ticket[] }>(
		'../../internal/fixtures/mocktickets.ts'
	);

	let eventSource: EventSource | null = null;
	let wakeLock: WakeLockSentinel | null = null;
	let rafHandle: number | null = null;
	let visibilityListener: (() => void) | null = null;
	let pageshowListener: (() => void) | null = null;

	function openStream(): void {
		if (!browser) return;
		if (mockMode) return;
		if (eventSource) {
			try {
				eventSource.close();
			} catch {
				/* already closed */
			}
			eventSource = null;
		}
		eventSource = new EventSource('/api/stream');
		eventSource.onopen = () => {
			connected = true;
		};
		eventSource.onerror = () => {
			connected = false;
		};
		eventSource.onmessage = (e: MessageEvent) => {
			try {
				const parsed = JSON.parse(e.data) as Ticket[];
				if (Array.isArray(parsed)) tickets = parsed;
			} catch {
				/* ignore malformed frame */
			}
		};
	}

	async function acquireWakeLock(): Promise<void> {
		if (!browser || !('wakeLock' in navigator)) return;
		try {
			wakeLock = await navigator.wakeLock.request('screen');
			wakeLock.addEventListener('release', () => {
				wakeLock = null;
			});
		} catch {
			/* iOS NotAllowedError if visibility not stable yet — caller retries */
		}
	}

	function deferredReacquireWakeLock(): void {
		if (!browser) return;
		if (rafHandle !== null) cancelAnimationFrame(rafHandle);
		rafHandle = requestAnimationFrame(() => {
			rafHandle = null;
			void acquireWakeLock();
		});
	}

	function onVisibilityChange(): void {
		if (document.visibilityState !== 'visible') return;
		openStream();
		deferredReacquireWakeLock();
	}

	function onPageShow(): void {
		openStream();
		deferredReacquireWakeLock();
	}

	async function focusSession(ticket: Ticket): Promise<void> {
		focusing = ticket.session_id;
		try {
			await fetch('/api/focus', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ pane: ticket.tmux_pane })
			});
		} catch {
			/* failure is shown only as a missed focus — daemon-side log is the record */
		} finally {
			setTimeout(() => {
				if (focusing === ticket.session_id) focusing = null;
			}, 300);
		}
	}

	function projectLabel(cwd: string): string {
		if (!cwd) return '';
		const parts = cwd.split('/').filter(Boolean);
		return parts[parts.length - 1] ?? cwd;
	}

	function typeClass(t: EventType): string {
		if (t === 'PermissionRequest') return 'type-permission';
		if (t === 'Notification') return 'type-notification';
		return 'type-stop';
	}

	function typeLabel(t: EventType): string {
		if (t === 'PermissionRequest') return 'PERMISSION';
		if (t === 'Notification') return 'NOTIFY';
		return 'STOP';
	}

	function formatAge(createdAt: number, now: number): string {
		const seconds = Math.max(0, Math.floor((now - createdAt) / 1000));
		if (seconds < 5) return 'now';
		if (seconds < 60) return `${seconds}s`;
		const minutes = Math.floor(seconds / 60);
		if (minutes < 60) return `${minutes}m`;
		const hours = Math.floor(minutes / 60);
		return `${hours}h`;
	}

	let now = $state(Date.now());
	let ageTimer: ReturnType<typeof setInterval> | null = null;

	onMount(async () => {
		if (browser && new URLSearchParams(window.location.search).has('mock')) {
			const loader = Object.values(mockLoaders)[0];
			if (loader) {
				mockMode = true;
				connected = true;
				const mod = await loader();
				tickets = mod.getMockTickets();
			}
		}
		openStream();
		void acquireWakeLock();
		visibilityListener = onVisibilityChange;
		pageshowListener = onPageShow;
		document.addEventListener('visibilitychange', visibilityListener);
		window.addEventListener('pageshow', pageshowListener);
		ageTimer = setInterval(() => {
			now = Date.now();
		}, 5000);
	});

	onDestroy(() => {
		if (eventSource) {
			try {
				eventSource.close();
			} catch {
				/* already closed */
			}
			eventSource = null;
		}
		if (wakeLock) {
			void wakeLock.release().catch(() => {});
			wakeLock = null;
		}
		if (rafHandle !== null && browser) {
			cancelAnimationFrame(rafHandle);
			rafHandle = null;
		}
		if (ageTimer !== null) {
			clearInterval(ageTimer);
			ageTimer = null;
		}
		if (browser && visibilityListener) {
			document.removeEventListener('visibilitychange', visibilityListener);
		}
		if (browser && pageshowListener) {
			window.removeEventListener('pageshow', pageshowListener);
		}
	});
</script>

<svelte:head>
	<title>Expediter</title>
</svelte:head>

<main>
	<header>
		<div class="brand">
			<span class="brand-name">Expediter</span>
			<span class="brand-version">(v0.1)</span>
		</div>
		<span class="conn" class:on={connected} aria-label={connected ? 'connected' : 'disconnected'}
		></span>
	</header>

	{#if tickets.length === 0}
		<div class="empty" aria-live="polite">
			<span class="dot"></span>
			<span class="empty-label">all clear</span>
		</div>
	{:else}
		<ul class="queue">
			{#each tickets as ticket (ticket.session_id)}
				<li
					class="ticket {typeClass(ticket.event_type)}"
					class:pressing={focusing === ticket.session_id}
					animate:flip={{ duration: 220 }}
					in:fly={{ y: -8, duration: 180 }}
					out:fly={{ y: 8, duration: 140 }}
				>
					<button type="button" onclick={() => focusSession(ticket)}>
						<div class="stub">
							<span class="type">{typeLabel(ticket.event_type)}</span>
							<span class="age">{formatAge(ticket.created_at, now)}</span>
						</div>
						<div class="perforation" aria-hidden="true"></div>
						<div class="body">
							<div class="title">{ticket.title}</div>
							{#if ticket.cwd}
								<div class="project">{projectLabel(ticket.cwd)}</div>
							{/if}
						</div>
					</button>
				</li>
			{/each}
		</ul>
	{/if}
</main>

<style>
	:global(html, body) {
		margin: 0;
		padding: 0;
		background: #fffdf5;
		color: #e6e6e6;
		font-family:
			ui-monospace,
			'SF Mono',
			'JetBrains Mono',
			Menlo,
			Consolas,
			monospace;
		font-size: 16px;
		-webkit-font-smoothing: antialiased;
		overscroll-behavior: none;
	}

	:global(*) {
		box-sizing: border-box;
	}

	main {
		min-height: 100vh;
		padding: calc(env(safe-area-inset-top, 0) + 14px) 14px
			calc(env(safe-area-inset-bottom, 0) + 14px) 14px;
		display: flex;
		flex-direction: column;
		gap: 16px;
	}

	header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0 4px;
	}

	.brand {
		display: flex;
		align-items: baseline;
		gap: 7px;
		font-size: 14px;
		letter-spacing: 0.01em;
		color: #2a1f15;
	}
	.brand-name {
		font-weight: 600;
	}
	.brand-version {
		font-size: 11px;
		font-weight: 500;
		color: rgba(42, 31, 21, 0.38);
		letter-spacing: 0.04em;
	}

	.conn {
		position: relative;
		width: 11px;
		height: 11px;
		border: 1px solid #c9bd9a;
		border-radius: 50%;
		box-sizing: border-box;
		transition:
			border-color 200ms ease,
			box-shadow 200ms ease;
	}
	.conn::before {
		content: '';
		position: absolute;
		inset: 2px;
		border-radius: 50%;
		background: #c9bd9a;
		transition: background 200ms ease;
	}
	.conn.on {
		border-color: #5b8a3a;
		box-shadow: 0 0 0 3px rgba(91, 138, 58, 0.12);
	}
	.conn.on::before {
		background: #5b8a3a;
		animation: led-breathe 2.4s ease-in-out infinite;
	}
	@keyframes led-breathe {
		0%,
		100% {
			opacity: 1;
		}
		50% {
			opacity: 0.55;
		}
	}

	.empty {
		flex: 1;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 16px;
		color: #3a3a3a;
	}
	.empty .dot {
		width: 10px;
		height: 10px;
		border-radius: 50%;
		background: #2a2a2a;
	}
	.empty-label {
		font-size: 13px;
		letter-spacing: 0.18em;
		text-transform: uppercase;
	}

	.queue {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 16px;
	}

	.ticket {
		--page-bg: #fffdf5;
		--bg: #fff1c9;
		--border: #ead68f;
		--title: #2a1f15;
		--muted: #8a7a45;
		--accent: #6e5a20;
		--notch-size: 18px;
		--notch-offset: 14px;

		position: relative;
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: 0;
		box-shadow:
			0 1px 0 rgba(80, 60, 30, 0.04),
			0 2px 10px rgba(80, 60, 30, 0.06);
		transition: transform 120ms ease;
	}
	.ticket.type-permission {
		--bg: #f9d5cc;
		--border: #e0a89a;
		--title: #5a1e1a;
		--muted: #a06860;
		--accent: #8b2e1f;
	}
	.ticket.type-notification {
		--bg: #ffe0c8;
		--border: #e8c0a0;
		--title: #4a2f1a;
		--muted: #a07a55;
		--accent: #8a5a28;
	}
	.ticket.pressing {
		transform: scale(0.985);
	}

	.ticket button {
		display: block;
		width: 100%;
		text-align: left;
		background: transparent;
		border: 0;
		color: inherit;
		font: inherit;
		padding: 0;
		cursor: pointer;
	}

	.stub {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		padding: 12px 18px;
		font-size: 11px;
		letter-spacing: 0.22em;
		text-transform: uppercase;
	}
	.stub .type {
		color: var(--accent);
		font-weight: 700;
	}
	.stub .age {
		color: var(--muted);
		font-variant-numeric: tabular-nums;
		letter-spacing: 0.04em;
		font-weight: 600;
		text-transform: none;
	}

	.perforation {
		position: relative;
		height: 1px;
		margin: 0 var(--notch-offset);
		background-image: linear-gradient(
			to right,
			var(--border) 0,
			var(--border) 4px,
			transparent 4px,
			transparent 8px
		);
		background-size: 8px 1px;
		background-repeat: repeat-x;
	}
	.perforation::before,
	.perforation::after {
		content: '';
		position: absolute;
		top: 50%;
		width: var(--notch-size);
		height: var(--notch-size);
		border-radius: 50%;
		background: var(--page-bg);
		transform: translateY(-50%);
	}
	.perforation::before {
		left: calc(-1 * (var(--notch-offset) + var(--notch-size) / 2));
	}
	.perforation::after {
		right: calc(-1 * (var(--notch-offset) + var(--notch-size) / 2));
	}

	.body {
		padding: 14px 18px 18px;
	}

	.title {
		font-size: 16px;
		line-height: 1.4;
		color: var(--title);
		word-break: break-word;
	}

	.project {
		margin-top: 10px;
		font-size: 11px;
		color: var(--muted);
		letter-spacing: 0.08em;
		text-transform: lowercase;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
</style>
