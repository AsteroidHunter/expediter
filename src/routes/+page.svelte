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

	let eventSource: EventSource | null = null;
	let wakeLock: WakeLockSentinel | null = null;
	let rafHandle: number | null = null;
	let visibilityListener: (() => void) | null = null;
	let pageshowListener: (() => void) | null = null;

	function openStream(): void {
		if (!browser) return;
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

	onMount(() => {
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
		<span class="brand">expediter</span>
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
					class="ticket"
					class:permission={ticket.event_type === 'PermissionRequest'}
					class:pressing={focusing === ticket.session_id}
					animate:flip={{ duration: 220 }}
					in:fly={{ y: -8, duration: 180 }}
					out:fly={{ y: 8, duration: 140 }}
				>
					<button type="button" onclick={() => focusSession(ticket)}>
						<div class="title">{ticket.title}</div>
						<div class="meta">
							<span class="project">{projectLabel(ticket.cwd)}</span>
							<span class="age">{formatAge(ticket.created_at, now)}</span>
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
		background: #0a0a0a;
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
		font-size: 13px;
		letter-spacing: 0.18em;
		text-transform: uppercase;
		color: #6e6e6e;
	}

	.conn {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: #3a3a3a;
		transition: background 200ms ease;
	}
	.conn.on {
		background: #4ade80;
		box-shadow: 0 0 8px rgba(74, 222, 128, 0.4);
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
		gap: 10px;
	}

	.ticket {
		background: #141414;
		border: 1px solid #1f1f1f;
		border-radius: 14px;
		overflow: hidden;
		transition:
			transform 120ms ease,
			background 120ms ease;
	}
	.ticket.permission {
		background: #1a0f12;
		border-color: #4a1c25;
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
		padding: 16px 18px;
		cursor: pointer;
	}

	.title {
		font-size: 17px;
		line-height: 1.3;
		color: #f4f4f4;
		word-break: break-word;
	}
	.ticket.permission .title {
		color: #ffb4b9;
	}

	.meta {
		margin-top: 8px;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		font-size: 12px;
		color: #6e6e6e;
		letter-spacing: 0.04em;
	}
	.project {
		max-width: 70%;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.age {
		font-variant-numeric: tabular-nums;
	}
</style>
