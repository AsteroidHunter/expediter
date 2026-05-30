<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { fly } from 'svelte/transition';
	import { flip } from 'svelte/animate';
	import { browser } from '$app/environment';
	import { getClientToken, clearClientToken } from '$lib/clientToken';

	type EventType = 'Stop' | 'PermissionRequest' | 'Notification' | 'Idle';
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
	// Sticky: flips true on the first successful onopen and never resets. Without
	// it, isDisconnected would flash on every page load and every wake-from-
	// background, because `connected` starts false and openStream reopens the
	// EventSource on visibilitychange / pageshow before onopen has had a chance
	// to fire again.
	let everConnected = $state(false);
	let focusing = $state<string | null>(null);
	// In-memory only; lost on page reload. Marks the most recently tapped ticket
	// so the user has a visual "this is the session I jumped into" cue. Goes
	// stale if the user switches sessions inside the terminal directly — that's
	// accepted for v0; proper "currently focused pane" tracking would need
	// AppleScript polling on the server.
	let lastTapped = $state<string | null>(null);
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

	// Brave/iOS fallback for keeping the screen awake. Third-party iOS browsers
	// (Brave, etc.) are WebKit-based but do not expose `navigator.wakeLock`, so the
	// acquireWakeLock() path above silently no-ops there and the screen locks on
	// the OS timer. A muted, looping 1px <video> is the only mechanism iOS offers
	// to defer auto-lock without a tap. Gated to mount ONLY when the native API is
	// absent, so Safari / installed PWAs keep using the real Wake Lock and never
	// spin up a redundant decoder.
	//
	// The asset (static/keep-awake.mp4) is encoded with NO audio track on purpose:
	// a video carrying any audio track — even a silent one — claims the iOS audio
	// session and pauses the user's music/podcast. An audio-free track never does.
	let keepAliveVideo = $state<HTMLVideoElement | null>(null);
	const useVideoFallback = browser && !('wakeLock' in navigator);

	// Drive the fallback video off the same `connected` state as the green dot:
	// play while the SSE stream is live (hold the screen on), pause when it drops
	// (no live data — let the phone sleep). Re-setting `.muted` in JS is
	// deliberate: the muted *attribute* does not reliably reflect to the property,
	// and WebKit only autoplays a genuinely-muted element.
	$effect(() => {
		const v = keepAliveVideo;
		if (!useVideoFallback || !v) return;
		if (connected) {
			v.muted = true;
			void v.play().catch(() => {
				/* autoplay refused (e.g. Low Power Mode) — nothing to do */
			});
		} else {
			v.pause();
		}
	});

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
			everConnected = true;
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
		lastTapped = ticket.session_id;
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
			}, 80);
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
		if (t === 'Idle') return 'type-idle';
		return 'type-stop';
	}

	function typeLabel(t: EventType): string {
		if (t === 'PermissionRequest') return 'PERMISSION';
		if (t === 'Notification') return 'NOTIFY';
		if (t === 'Idle') return 'IDLE';
		return 'STOP';
	}

	// Idle Stop/Notification tickets desaturate in step jumps as they age, so a
	// glanceable signal of "how stale is this thing" is built into the dock.
	// PermissionRequest never fades (load-bearing red attention); working state
	// owns its own pastel-green visual and skips fading too.
	function staleClass(ticket: Ticket, now: number): string {
		if (ticket.working) return '';
		if (ticket.event_type === 'PermissionRequest') return '';
		// Idle tickets are already fully desaturated via .type-idle CSS — stale
		// tiers (which apply additional saturate() filters) would be redundant.
		if (ticket.event_type === 'Idle') return '';
		const ageMin = (now - ticket.created_at) / 60_000;
		if (ageMin >= 32) return 'stale-4';
		if (ageMin >= 16) return 'stale-3';
		if (ageMin >= 8) return 'stale-2';
		if (ageMin >= 4) return 'stale-1';
		return '';
	}

	// True only after we successfully connected at least once AND have since lost
	// the SSE — i.e. the daemon went away or the network dropped. The
	// everConnected guard prevents a false "disconnected" flash on initial load
	// and on background-wake reconnects.
	const isDisconnected = $derived(!!clientToken && !connected && everConnected);

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

	// Settings menu + two-tap shutdown. shutdownArmed flips true on the first
	// tap and back to false on a 4s timer, on settings-close, or on the second
	// confirming tap. The 4s window is short enough that an accidental first
	// tap doesn't sit there pre-armed for long, and long enough that a
	// deliberate user can comfortably tap again.
	let settingsOpen = $state(false);
	let shutdownArmed = $state(false);
	let shuttingDown = $state(false);
	let shutdownArmTimer: ReturnType<typeof setTimeout> | null = null;

	function disarmShutdown(): void {
		shutdownArmed = false;
		if (shutdownArmTimer !== null) {
			clearTimeout(shutdownArmTimer);
			shutdownArmTimer = null;
		}
	}

	function toggleSettings(): void {
		settingsOpen = !settingsOpen;
		if (!settingsOpen) disarmShutdown();
	}

	function closeSettings(): void {
		settingsOpen = false;
		disarmShutdown();
	}

	function onShutdownClick(): void {
		if (!shutdownArmed) {
			shutdownArmed = true;
			shutdownArmTimer = setTimeout(disarmShutdown, 4000);
			return;
		}
		disarmShutdown();
		if (!clientToken) return;
		shuttingDown = true;
		// Fire-and-forget: the daemon exits ~100ms after acknowledging, so the
		// response may never reach us cleanly. Awaiting would leave the
		// "Shutting down..." label visible until the network stack timed out.
		// Instead, fire the request, briefly flash the label as feedback, and
		// then close the panel — the existing isDisconnected overlay takes
		// over once the SSE drops.
		void fetch('/api/shutdown', {
			method: 'POST',
			headers: { 'x-expediter-token': clientToken }
		}).catch(() => {});
		setTimeout(() => {
			settingsOpen = false;
			shuttingDown = false;
		}, 600);
	}

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
		if (shutdownArmTimer !== null) {
			clearTimeout(shutdownArmTimer);
			shutdownArmTimer = null;
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
			<span class="brand-version">(v0.72)</span>
		</div>
		<div class="header-right">
			{#if clientToken}
				<button
					type="button"
					class="gear"
					class:open={settingsOpen}
					aria-label="Settings"
					aria-expanded={settingsOpen}
					onclick={toggleSettings}
				>
					<svg
						viewBox="0 0 24 24"
						width="18"
						height="18"
						fill="none"
						stroke="currentColor"
						stroke-width="1.6"
						stroke-linecap="round"
						stroke-linejoin="round"
						aria-hidden="true"
					>
						<circle cx="12" cy="12" r="3" />
						<path
							d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"
						/>
					</svg>
				</button>
			{/if}
			<span class="conn" class:on={connected} aria-label={connected ? 'connected' : 'disconnected'}
			></span>
		</div>
	</header>

	{#if settingsOpen}
		<div
			class="settings-backdrop"
			role="presentation"
			onclick={closeSettings}
		></div>
		<div class="settings-panel" role="menu">
			<button
				type="button"
				class="settings-action danger"
				class:armed={shutdownArmed}
				disabled={shuttingDown}
				onclick={onShutdownClick}
			>
				<svg
					class="action-icon"
					viewBox="0 0 24 24"
					width="18"
					height="18"
					fill="none"
					stroke="currentColor"
					stroke-width="1.8"
					stroke-linecap="round"
					stroke-linejoin="round"
					aria-hidden="true"
				>
					<path d="M12 3v9" />
					<path d="M18.36 6.64a9 9 0 1 1-12.73 0" />
				</svg>
				<span class="action-label">
					{#if shuttingDown}
						Ending connection...
					{:else if shutdownArmed}
						Tap to confirm
					{:else}
						End connection
					{/if}
				</span>
			</button>
		</div>
	{/if}

	{#if !clientToken}
		<div class="empty empty-no-token" aria-live="polite">
			<span class="empty-label">Scan the QR code in your terminal to connect</span>
		</div>
	{:else if tickets.length === 0 && !isDisconnected}
		<div class="empty" aria-live="polite">
			<span class="dot"></span>
			<span class="empty-label">You have zero tickets!</span>
		</div>
	{:else if tickets.length === 0}
		<div class="empty" aria-live="polite"></div>
	{:else}
		<ul class="queue" class:disconnected={isDisconnected}>
			{#each tickets as ticket (ticket.session_id)}
				<li
					class="ticket {typeClass(ticket.event_type)} {staleClass(ticket, now)}"
					class:pressing={focusing === ticket.session_id}
					class:working={ticket.working}
					class:tapped={lastTapped === ticket.session_id}
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
							<span class="type">{ticket.working ? 'COOKING' : typeLabel(ticket.event_type)}</span>
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

	{#if isDisconnected}
		<div class="disconnected-overlay" role="status" aria-live="polite">
			<span>you are disconnected</span>
		</div>
	{/if}

	{#if useVideoFallback}
		<!-- Keep-screen-awake fallback for Brave/iOS — see useVideoFallback in the
		     script. Audio-free 1px loop; play/pause is driven by the $effect. -->
		<!-- svelte-ignore a11y_media_has_caption -->
		<video
			bind:this={keepAliveVideo}
			class="keep-awake"
			muted
			loop
			playsinline
			preload="auto"
			aria-hidden="true"
			tabindex="-1"
		>
			<source src="/keep-awake.mp4" type="video/mp4" />
		</video>
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

	/* Fallback keep-awake video: must stay rendered and on-screen (WebKit halts
	   playback for display:none / fully-transparent elements), but invisible and
	   inert. 1px + near-zero opacity satisfies "visible" without showing a dot. */
	.keep-awake {
		position: fixed;
		right: 0;
		bottom: 0;
		width: 1px;
		height: 1px;
		opacity: 0.01;
		pointer-events: none;
		border: 0;
		z-index: -1;
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
		font-size: 18px;
		letter-spacing: 0.01em;
		color: #2a1f15;
	}
	.brand-name {
		font-weight: 600;
	}
	.brand-version {
		font-size: 14px;
		font-weight: 500;
		color: rgba(42, 31, 21, 0.38);
		letter-spacing: 0.04em;
	}

	.header-right {
		display: flex;
		align-items: center;
		gap: 12px;
	}

	.gear {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		background: transparent;
		border: 0;
		padding: 4px;
		margin: -4px;
		color: rgba(42, 31, 21, 0.45);
		cursor: pointer;
		-webkit-tap-highlight-color: transparent;
		transition:
			color 150ms ease,
			transform 200ms ease;
	}
	.gear:hover,
	.gear.open {
		color: #2a1f15;
	}
	.gear.open {
		transform: rotate(45deg);
	}

	/* Full-viewport blurred backdrop. Dims and blurs the dock behind the panel
	   so the menu has visual focus, and absorbs off-panel taps to dismiss.
	   backdrop-filter is Safari-supported via -webkit- prefix. Fades in. */
	.settings-backdrop {
		position: fixed;
		inset: 0;
		z-index: 20;
		background: rgba(42, 31, 21, 0.18);
		-webkit-backdrop-filter: blur(6px);
		backdrop-filter: blur(6px);
		animation: settings-backdrop-fade 160ms ease both;
	}
	@keyframes settings-backdrop-fade {
		from {
			opacity: 0;
		}
		to {
			opacity: 1;
		}
	}

	/* Viewport-centered panel. Fixed positioning + translate centers it across
	   both axes. min-width keeps the action label from wrapping. Panel scales
	   in from the center. */
	.settings-panel {
		position: fixed;
		top: 50%;
		left: 50%;
		z-index: 21;
		background: #fffdf5;
		border: 1px solid #c9bd9a;
		box-shadow: 0 12px 32px rgba(80, 60, 30, 0.22);
		min-width: 240px;
		padding: 4px;
		display: flex;
		flex-direction: column;
		gap: 2px;
		transform-origin: center;
		animation: settings-panel-pop 180ms cubic-bezier(0.2, 0.9, 0.3, 1.2) both;
	}
	@keyframes settings-panel-pop {
		from {
			opacity: 0;
			transform: translate(-50%, -50%) scale(0.94);
		}
		to {
			opacity: 1;
			transform: translate(-50%, -50%) scale(1);
		}
	}
	.settings-action {
		display: flex;
		align-items: center;
		gap: 10px;
		background: transparent;
		border: 0;
		color: #2a1f15;
		font: inherit;
		font-size: 13px;
		letter-spacing: 0.04em;
		text-align: left;
		padding: 14px 16px;
		cursor: pointer;
		-webkit-tap-highlight-color: transparent;
		transition:
			background 120ms ease,
			color 120ms ease;
	}
	.settings-action .action-icon {
		flex-shrink: 0;
	}
	.settings-action .action-label {
		flex: 1;
	}
	.settings-action:hover {
		background: rgba(201, 189, 154, 0.18);
	}
	.settings-action.danger {
		color: #8b2e1f;
	}
	/* Armed state: first tap on a destructive action. Background flips to the
	   PermissionRequest palette so the "this will kill the daemon" reading is
	   unambiguous, and the label changes to "Tap to confirm". Reverts on the
	   4s timer or on closing the panel. */
	.settings-action.armed {
		background: #f9d5cc;
		color: #5a1e1a;
		font-weight: 600;
	}
	.settings-action:disabled {
		opacity: 0.55;
		cursor: default;
	}

	.conn {
		position: relative;
		width: 14px;
		height: 14px;
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
		box-shadow: 0 0 0 4px rgba(91, 138, 58, 0.12);
	}
	/* Shown when isDisconnected: a viewport-centered status overlay. The queue
	   below fades out slowly via the .queue.disconnected transition, leaving
	   this message as the dominant element. pointer-events: none so the
	   overlay never intercepts taps. */
	.disconnected-overlay {
		position: fixed;
		inset: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		pointer-events: none;
		z-index: 10;
		font-size: 14px;
		letter-spacing: 0.22em;
		text-transform: uppercase;
		color: rgba(42, 31, 21, 0.6);
		animation: disconnected-fade-in 900ms ease both;
	}
	@keyframes disconnected-fade-in {
		from {
			opacity: 0;
		}
		to {
			opacity: 1;
		}
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
		transition: opacity 1.2s ease;
	}
	/* When the SSE drops, the ticket list slowly fades to fully transparent and
	   stops accepting taps. The viewport-centered .disconnected-overlay takes
	   over as the dominant signal. pointer-events: none cascades down to the
	   ticket buttons so a tap during the fade-out can't queue /api/focus
	   against a dead daemon. */
	.queue.disconnected {
		opacity: 0;
		pointer-events: none;
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
	/* Idle tickets are seeded by the boot scan (and the SessionStart hook) for
	   sessions that haven't emitted a real event yet. Fully desaturated AND
	   given a translucent fill (rgba --bg) so the page shows through and a
	   never-touched session reads as a fainter card than an aged Stop (which
	   desaturates to the same grey via .stale-4 but keeps a solid fill). Only
	   the fill is translucent; text and border stay crisp, unlike element
	   opacity which faded the whole ticket. */
	.ticket.type-idle {
		filter: saturate(0);
		--bg: rgba(255, 241, 201, 0.5);
	}
	.ticket.pressing {
		transform: scale(0.985);
	}
	/* "Tapped" marker: the most recently tapped ticket gets a stronger drop
	   shadow so the user can see at a glance which session they jumped into.
	   Pure box-shadow + z-index (no transform) so it composes cleanly with
	   pressing/working/stale, which all use their own properties. Persists
	   until another ticket is tapped or the page reloads. */
	.ticket.tapped .title {
		font-weight: 700;
	}
	/* Stale tiers for idle Stop/Notification tickets. Step desaturation at 4 / 8 /
	   16 / 32 minutes; filter applies to the whole ticket including text + border
	   so the entire palette ages together. Placed before .ticket.working so the
	   working pastel-green wins if both classes ever co-applied (the helper
	   skips stale on working/permission tickets, so this is defensive). */
	.ticket.stale-1 {
		filter: saturate(0.75);
	}
	.ticket.stale-2 {
		filter: saturate(0.5);
	}
	.ticket.stale-3 {
		filter: saturate(0.25);
	}
	.ticket.stale-4 {
		filter: saturate(0);
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
		-webkit-tap-highlight-color: transparent;
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
	/* Perforation end-caps. Each cap is a half-disc that sits flush against the
	   ticket's left or right edge (flat side aligned with the perimeter,
	   rounded side bulging inward). Cap is offset 1px past the ticket edge so
	   its background covers the ticket's straight border at the notch height,
	   then the cap's own curved border continues the perimeter inward around
	   the cutout. Result reads as a punched notch in the ticket, not a disc
	   stuck on top of it. Fill is var(--page-bg) so the cutout shows the page
	   color through. */
	.perforation::before,
	.perforation::after {
		content: '';
		position: absolute;
		top: 50%;
		width: calc(var(--notch-size) / 2);
		height: var(--notch-size);
		background-color: var(--page-bg);
		transform: translateY(-50%);
	}
	.perforation::before {
		left: calc(-1 * var(--notch-offset) - 1px);
		border-radius: 0 var(--notch-size) var(--notch-size) 0;
	}
	.perforation::after {
		right: calc(-1 * var(--notch-offset) - 1px);
		border-radius: var(--notch-size) 0 0 var(--notch-size);
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
