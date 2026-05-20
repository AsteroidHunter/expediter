<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { fly } from 'svelte/transition';
	import { flip } from 'svelte/animate';
	import { browser } from '$app/environment';
	import { getClientToken, clearClientToken } from '$lib/clientToken';

	type EventType = 'Stop' | 'PermissionRequest' | 'Notification';
	// `title` may be empty string before the async topic refresh has run;
	// rendered conditionally so empty values produce no element.
	type Ticket = {
		session_id: string;
		tmux_pane: string;
		cwd: string;
		title: string;
		event_type: EventType;
		created_at: number;
		working: boolean;
	};

	let tickets = $state<Ticket[]>([]);
	let connected = $state(false);
	let focusing = $state<string | null>(null);
	let mockMode = false;
	// Reactive: cleared when /api/ping returns 403 (token died, daemon restarted).
	// Initial value is read from sessionStorage on the browser; null on the server.
	let clientToken = $state<string | null>(browser ? getClientToken() : null);

	const mockLoaders = import.meta.glob<{ getMockTickets: () => Ticket[] }>(
		'../../internal/fixtures/mocktickets.ts'
	);

	let eventSource: EventSource | null = null;
	let wakeLock: WakeLockSentinel | null = null;
	let rafHandle: number | null = null;
	let visibilityListener: (() => void) | null = null;
	let pageshowListener: (() => void) | null = null;

	// Background probe to detect a dead token (daemon restarted while we slept).
	// 403 means our sessionStorage value is stale — clear it so the empty-state
	// branch flips to "Scan the QR code...". 200 or any error means "token is
	// still good (or we can't tell) — let EventSource auto-reconnect handle the
	// transient case."
	async function probeToken(): Promise<'valid' | 'dead' | 'unknown'> {
		if (!clientToken) return 'dead';
		try {
			const res = await fetch('/api/ping', {
				headers: { 'x-expediter-token': clientToken },
				signal: AbortSignal.timeout(2000)
			});
			if (res.status === 403) return 'dead';
			return 'valid';
		} catch {
			return 'unknown';
		}
	}

	async function openStream(): Promise<void> {
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
		if (!clientToken) {
			connected = false;
			return;
		}
		const status = await probeToken();
		if (status === 'dead') {
			clearClientToken();
			clientToken = null;
			connected = false;
			return;
		}
		// status === 'valid' or 'unknown' — open the EventSource. For 'unknown'
		// (network blip), EventSource's retry loop will handle reconnection.
		eventSource = new EventSource(
			`/api/stream?t=${encodeURIComponent(clientToken)}`
		);
		eventSource.onopen = () => {
			connected = true;
		};
		eventSource.onerror = () => {
			connected = false;
			// Fire-and-forget re-probe to catch the daemon-restart case where the
			// SSE was working until the daemon went away.
			if (clientToken) {
				void probeToken().then((s) => {
					if (s === 'dead') {
						clearClientToken();
						clientToken = null;
						if (eventSource) {
							try {
								eventSource.close();
							} catch {
								/* already closed */
							}
							eventSource = null;
						}
					}
				});
			}
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
		if (!clientToken) {
			// No token in sessionStorage — the empty-state branch should be visible
			// anyway, but if the user somehow taps a stale ticket without one, no-op.
			return;
		}
		focusing = ticket.session_id;
		try {
			await fetch('/api/focus', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'x-expediter-token': clientToken
				},
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

	{#if !clientToken}
		<div class="empty empty-no-token" aria-live="polite">
			<span class="empty-label">Scan the QR code in your terminal to connect</span>
		</div>
	{:else if tickets.length === 0}
		<div class="empty" aria-live="polite">
			<span class="dot"></span>
			<span class="empty-label">You have zero tickets!</span>
		</div>
	{:else}
		<ul class="queue">
			{#each tickets as ticket (ticket.session_id)}
				<li
					class="ticket {typeClass(ticket.event_type)}"
					class:pressing={focusing === ticket.session_id}
					class:working={ticket.working}
					animate:flip={{ duration: 220 }}
					in:fly={{ y: -8, duration: 180 }}
					out:fly={{ y: 8, duration: 140 }}
				>
					<button type="button" onclick={() => focusSession(ticket)}>
						{#if ticket.working}
							<div class="shimmer" aria-hidden="true">
								<div class="shimmer-stripe"></div>
							</div>
						{/if}
						<div class="stub">
							<span class="project">{projectLabel(ticket.cwd)}</span>
							<span class="type">{typeLabel(ticket.event_type)}</span>
							<span class="age">{formatAge(ticket.created_at, now)}</span>
						</div>
						<div class="perforation" aria-hidden="true"></div>
						<div class="body">
							{#if ticket.title}
								<div class="title">{ticket.title}</div>
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
		text-align: center;
		padding: 0 24px;
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
		transition:
			transform 120ms ease,
			background-color 150ms ease,
			border-color 150ms ease,
			color 150ms ease;
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
	/* "Working" state: Claude is processing (UserPromptSubmit / PostToolUse /
	   PostToolUseFailure). The ticket depresses (scale 0.985) and renders in a
	   pastel-green palette that overrides the event_type tint, so an approved
	   PermissionRequest stops reading as red while Claude finishes the tool.
	   A white shimmer stripe sweeps left→right behind the stub/body text (the
	   text and the perforation notches paint on top via z-index / tree order),
	   keeping the perforated silhouette intact. Flips back automatically on
	   the next Stop / PermissionRequest / Notification, since upsert clears
	   the working flag. */
	.ticket.working {
		transform: scale(0.985);
		--bg: #d4e6c8;
		--border: #a8c890;
		--title: #1f3a1f;
		--muted: #6b8a55;
		--accent: #3a5e2a;
	}
	.shimmer {
		position: absolute;
		inset: 0;
		overflow: hidden;
		pointer-events: none;
	}
	.shimmer-stripe {
		position: absolute;
		inset: 0;
		background: linear-gradient(
			90deg,
			transparent 0%,
			rgba(255, 255, 255, 0.55) 50%,
			transparent 100%
		);
		animation: ticket-working-shimmer 1.6s linear infinite;
		will-change: transform;
	}
	@keyframes ticket-working-shimmer {
		0% {
			transform: translateX(-100%);
		}
		100% {
			transform: translateX(100%);
		}
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
		position: relative;
		z-index: 1;
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: 10px;
		padding: 12px 18px;
		font-size: 11px;
		letter-spacing: 0.22em;
		text-transform: uppercase;
	}
	.stub .project {
		flex: 1;
		min-width: 0;
		color: var(--title);
		font-weight: 600;
		letter-spacing: 0.04em;
		text-transform: none;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.stub .type {
		flex-shrink: 0;
		color: var(--accent);
		font-weight: 700;
	}
	.stub .age {
		flex-shrink: 0;
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
		position: relative;
		z-index: 1;
		padding: 14px 18px 18px;
	}

	.title {
		font-size: 16px;
		line-height: 1.4;
		color: var(--title);
		word-break: break-word;
	}

</style>
