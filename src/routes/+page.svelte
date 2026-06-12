<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { fly } from 'svelte/transition';
	import { flip } from 'svelte/animate';
	import { browser } from '$app/environment';
	import { getClientToken, clearClientToken } from '$lib/clientToken';
	import { startVoiceSession, type VoiceSession, type VoiceBackend } from '$lib/voiceClient';
	import type { VoiceController, VoiceState } from '$lib/voice';

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
		// True when the tmux session has an attached client. Splits the dock into
		// the Attached page (default) and the Detached page; detached cards render
		// uniform grey and tap to re-attach. May be absent on an old SSE frame —
		// treated as attached (the pre-feature default) via `!== false` below.
		attached: boolean;
		// True while a speech-to-prompt dictation is capturing for this session, set
		// by the daemon's /api/voice/* routes and streamed over SSE. Drives the
		// /voice mock waveform (the phone has no local audio on that backend). May be
		// absent on an old frame — treated as false.
		recording?: boolean;
	};

	let tickets = $state<Ticket[]>([]);
	// Latest SSE snapshot held back while a gesture is in flight (see layoutFrozen),
	// applied when the gesture ends so the list can't re-sort under the user's finger.
	let pendingTickets: Ticket[] | null = null;

	// ── Detach-by-hold gesture (Attached cards only) ──────────────────────────
	// Swipe a card left-to-right to ~30%, then keep holding ~1.75s to detach: the
	// whole card fades uniformly to nothing over the hold; on commit it leaves the
	// Attached page (others reflow) and the session detaches. Release early → snaps
	// back, nothing vanished. One card at a time.
	const DETACH_FRACTION = 0.3; // visual lock: the card slides this far (of its width)
	const DETACH_FINGER = 0.65; // finger travel (of card width) to reach the lock — the
	// resistance: you drag further than the card moves, easing in so it takes a
	// deliberate push to start rather than triggering on a light flick.
	const DETACH_HOLD_MS = 1750; // hold duration: the card fades to nothing over this, then commits
	let dragId = $state<string | null>(null); // card under an active horizontal drag
	let dragOffset = $state(0); // px translateX, >= 0 (card slides right)
	let holdArmed = $state(false); // reached the 30% lock; 2s timer running
	let fadeProgress = $state(0); // 0..1 right→left wipe during the hold
	let snapBack = $state(false); // animate offset→0 on early release
	let detachingOut = $state<Record<string, boolean>>({}); // committed → hidden from Attached
	// Non-reactive scratch for the in-flight gesture:
	let dragStartX = 0;
	let dragStartY = 0;
	let dragWidth = 1;
	let dragAxis: 'undecided' | 'h' | 'v' = 'undecided';
	let dragMoved = false; // a real drag happened → suppress the focus click after it
	let holdRaf: number | null = null;
	let holdStart = 0;
	let audioCtx: AudioContext | null = null;

	// Two pages — Attached (default) and Detached — switched by the bottom pager
	// bar (arrows only, no swipe). A ticket is attached unless explicitly false,
	// so a frame from an older daemon that omits the field stays on the Attached
	// page rather than vanishing to Detached.
	const PAGES = ['attached', 'detached'] as const;
	let pageIndex = $state(0);
	// Slide direction for the page transition: +1 moving toward Detached, -1 back
	// toward Attached. Drives the horizontal fly so a page switch reads as a slide
	// rather than the cards flashing in place.
	let pageDir = $state(1);
	const page = $derived(PAGES[pageIndex]);
	const attachedTickets = $derived(
		tickets.filter((t) => t.attached !== false && !detachingOut[t.session_id])
	);
	const detachedTickets = $derived(tickets.filter((t) => t.attached === false));
	const visibleTickets = $derived(pageIndex === 0 ? attachedTickets : detachedTickets);

	function prevPage(): void {
		if (pageIndex > 0) {
			pageDir = -1;
			pageIndex -= 1;
		}
	}
	function nextPage(): void {
		if (pageIndex < PAGES.length - 1) {
			pageDir = 1;
			pageIndex += 1;
		}
	}
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

	// Voice: tap-to-talk to the oppie orchestrator over a LiveKit room. 'idle' →
	// not connected; the rest mirror the controller's reported state. The
	// controller (and livekit-client) is loaded with a dynamic import() inside
	// toggleVoice so it never enters SSR or the entry bundle.
	let voiceState = $state<'idle' | VoiceState>('idle');
	let voiceDetail = $state<string>('');
	let voiceCtl: VoiceController | null = null;

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
		// Refresh which STT backend the gesture should drive on every (re)connect,
		// so a settings change is picked up without a full reload.
		void fetchVoiceBackend();
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
				if (!Array.isArray(parsed)) return;
				// Hold the layout still while a gesture is in flight (recording, the
				// review state, or a detach drag) so another session finishing doesn't
				// re-sort the list and yank the ticket out from under your finger. The
				// latest snapshot is buffered and applied when the gesture ends.
				if (layoutFrozen()) pendingTickets = parsed;
				else tickets = parsed;
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

	// Tap a card: an attached session hits /api/focus (raise its existing
	// terminal); a detached one hits /api/attach (open a fresh terminal running
	// `tmux attach`). Same press feedback either way; the next reconcile migrates
	// a re-attached card from the Detached page to the Attached page on its own.
	async function tapSession(ticket: Ticket, endpoint: string): Promise<void> {
		if (!clientToken) {
			// No token in sessionStorage — the empty-state branch should be visible
			// anyway, but if the user somehow taps a stale ticket without one, no-op.
			return;
		}
		focusing = ticket.session_id;
		lastTapped = ticket.session_id;
		try {
			await fetch(endpoint, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'x-expediter-token': clientToken
				},
				body: JSON.stringify({ pane: ticket.tmux_pane })
			});
		} catch {
			/* failure is shown only as a missed tap — daemon-side log is the record */
		} finally {
			setTimeout(() => {
				if (focusing === ticket.session_id) focusing = null;
			}, 80);
		}
	}

	// Detached taps are gated so one tap spawns exactly one `tmux attach` window.
	// A session is latched "attaching" from the tap until a fallback timeout (the
	// card normally migrates to the Attached page within ~1-2s as the client-
	// attached hook fires); re-taps while latched are ignored. Attached (focus)
	// taps aren't gated — re-raising a window is harmless and idempotent.
	let attaching = $state<Record<string, boolean>>({});

	function onTicketTap(ticket: Ticket): void {
		if (ticket.attached === false) {
			if (attaching[ticket.session_id]) return; // already spawning — ignore the re-tap
			const id = ticket.session_id;
			attaching = { ...attaching, [id]: true };
			void tapSession(ticket, '/api/attach');
			// Fallback unlatch in case the attach fails and the card never migrates,
			// so a later retry isn't permanently swallowed.
			setTimeout(() => {
				if (!attaching[id]) return;
				const next = { ...attaching };
				delete next[id];
				attaching = next;
			}, 3000);
			return;
		}
		void tapSession(ticket, '/api/focus');
	}

	// ── detach gesture handlers ───────────────────────────────────────────────
	function cancelHold(): void {
		if (holdRaf !== null) {
			cancelAnimationFrame(holdRaf);
			holdRaf = null;
		}
		holdArmed = false;
		fadeProgress = 0;
	}

	function resetDrag(): void {
		dragId = null;
		dragOffset = 0;
		dragAxis = 'undecided';
		cancelHold();
		// Detach drag over — apply any SSE snapshot held back during it.
		flushPendingTickets();
	}

	function startHold(): void {
		holdArmed = true;
		tapHaptic(); // buzz at the lock
		holdStart = performance.now();
		const tick = (now: number): void => {
			fadeProgress = Math.min(1, (now - holdStart) / DETACH_HOLD_MS);
			if (fadeProgress >= 1) {
				holdRaf = null;
				commitDetach();
				return;
			}
			holdRaf = requestAnimationFrame(tick);
		};
		holdRaf = requestAnimationFrame(tick);
	}

	function commitDetach(): void {
		const id = dragId;
		resetDrag();
		if (!id) return;
		const ticket = tickets.find((t) => t.session_id === id);
		if (!ticket || !clientToken) return;
		playWhoosh();
		// Hide from the Attached page immediately so the remaining cards reflow on
		// the whoosh; SSE then moves it to the Detached page once detach lands.
		detachingOut = { ...detachingOut, [id]: true };
		const token = clientToken;
		void fetch('/api/detach', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'x-expediter-token': token },
			body: JSON.stringify({ pane: ticket.tmux_pane })
		}).catch(() => {
			// detach failed — un-hide so the card reappears on the Attached page
			const next = { ...detachingOut };
			delete next[id];
			detachingOut = next;
		});
		// Drop the optimistic flag after SSE has had time to reflect the detach.
		setTimeout(() => {
			const next = { ...detachingOut };
			delete next[id];
			detachingOut = next;
		}, 4000);
	}

	function onCardTouchStart(e: TouchEvent, ticket: Ticket): void {
		if (ticket.attached === false) return; // detach gesture is Attached-only
		if (dragId) return; // one card at a time
		const t = e.touches[0];
		if (!t) return;
		dragId = ticket.session_id;
		dragStartX = t.clientX;
		dragStartY = t.clientY;
		dragAxis = 'undecided';
		dragOffset = 0;
		dragMoved = false;
		snapBack = false;
		dragWidth = (e.currentTarget as HTMLElement).getBoundingClientRect().width || 1;
	}

	function onCardTouchMove(e: TouchEvent, ticket: Ticket): void {
		if (dragId !== ticket.session_id) return;
		const t = e.touches[0];
		if (!t) return;
		const dx = t.clientX - dragStartX;
		const dy = t.clientY - dragStartY;
		if (dragAxis === 'undecided') {
			if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return; // wait for clear intent
			dragAxis = Math.abs(dx) > Math.abs(dy) ? 'h' : 'v';
			if (dragAxis === 'v') {
				resetDrag(); // vertical = scroll; let the browser have it (touch-action: pan-y)
				return;
			}
			dragMoved = true;
		}
		if (dragAxis !== 'h') return;
		const raw = Math.max(0, dx); // rightward finger travel (left-to-right swipe)
		const t2 = Math.min(1, raw / (DETACH_FINGER * dragWidth)); // needs a longer push than it moves
		const eased = Math.pow(t2, 2.5); // easeIn (t^2.5) — between quadratic and cubic
		dragOffset = DETACH_FRACTION * dragWidth * eased; // card moves slower than the finger; caps at 30%
		const atHold = t2 >= 1;
		if (atHold && !holdArmed) startHold();
		else if (!atHold && holdArmed) cancelHold();
	}

	function onCardTouchEnd(ticket: Ticket): void {
		if (dragId !== ticket.session_id) return;
		if (holdArmed && fadeProgress >= 1) return; // already committed via the rAF tick
		// Early release: cancel the hold, snap back to rest, leave nothing vanished.
		cancelHold();
		snapBack = true;
		dragOffset = 0;
		const id = ticket.session_id;
		setTimeout(() => {
			if (dragId === id) {
				dragId = null;
				dragAxis = 'undecided';
			}
			snapBack = false;
		}, 340);
	}

	function cardStyle(ticket: Ticket): string {
		if (dragId !== ticket.session_id) return '';
		// Springy easeOutBack on release; instant follow while dragging. On release,
		// opacity also eases back so a half-faded card doesn't snap to full.
		const transition = snapBack
			? 'transition: transform 320ms cubic-bezier(0.34, 1.56, 0.64, 1), opacity 200ms ease;'
			: 'transition: none;';
		// While holding, the whole card fades uniformly to nothing over the hold
		// (opacity 1→0); startHold's rAF drives fadeProgress across DETACH_HOLD_MS.
		const opacity = holdArmed ? `opacity: ${1 - fadeProgress};` : '';
		return `transform: translateX(${dragOffset}px); ${transition} ${opacity}`;
	}

	// Haptic tick at the lock — Android only (navigator.vibrate). iOS Safari has no
	// Vibration API, and the hidden <input switch> toggle hack that worked from
	// iOS 17.4–26.4 was patched in iOS 26.5 (a programmatic .click() no longer
	// fires a haptic — only a real user tap does), so there is no web haptic on
	// current iPhones. The spring + gradient wipe carry the signal there.
	function tapHaptic(): void {
		try {
			navigator.vibrate?.(15);
		} catch {
			/* no Vibration API (e.g. iOS Safari) */
		}
	}

	// Synthesized whoosh (no asset): filtered noise sweep. Best-effort — iOS mutes
	// web audio on the hardware silent switch, so the visual wipe is the real
	// signal and this is a bonus.
	function playWhoosh(): void {
		if (!browser) return;
		try {
			const Ctor =
				window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
			if (!Ctor) return;
			audioCtx ??= new Ctor();
			const ctx = audioCtx;
			const dur = 0.45;
			const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * dur), ctx.sampleRate);
			const data = buf.getChannelData(0);
			for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
			const src = ctx.createBufferSource();
			src.buffer = buf;
			const bp = ctx.createBiquadFilter();
			bp.type = 'bandpass';
			bp.Q.value = 0.7;
			bp.frequency.setValueAtTime(1800, ctx.currentTime);
			bp.frequency.exponentialRampToValueAtTime(300, ctx.currentTime + dur);
			const gain = ctx.createGain();
			gain.gain.setValueAtTime(0.0001, ctx.currentTime);
			gain.gain.exponentialRampToValueAtTime(0.32, ctx.currentTime + 0.06);
			gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
			src.connect(bp);
			bp.connect(gain);
			gain.connect(ctx.destination);
			src.start();
			src.stop(ctx.currentTime + dur);
		} catch {
			/* audio blocked / silent switch — bonus only */
		}
	}

	// ─── Speech-to-prompt gesture (Phase 5) ─────────────────────────────────
	// Press-and-hold a ticket ~HOLD_MS to start dictation (RECORDING); release to
	// enter REVIEW, where you explicitly tap ✓ to send or ✗ to discard (or hold again
	// to resume) — nothing sends on a timer. A press shorter than HOLD_MS (or one that
	// moves past the slop) falls through to the normal tap (focus/attach). One
	// recording at a time (v1).
	const HOLD_MS = 1000; // press duration to arm recording (~1–2s per the plan)
	const SLOP = 10; // px of movement that reclassifies a hold as a scroll

	let sttBackend = $state<VoiceBackend>('voice');
	let voicePhase = $state<'idle' | 'recording' | 'draining'>('idle');
	let voiceTicketId = $state<string | null>(null);
	let voiceError = $state<string | null>(null);
	let voiceErrorTimer: ReturnType<typeof setTimeout> | null = null;

	// A completed long-press (or a tap during the drain) is followed by a synthetic
	// click; this flag lets the ticket's onclick swallow that one click so a voice
	// gesture doesn't also fire focus/attach. (The detach swipe has its own dragMoved
	// guard on the same onclick.) Auto-clears so it can't get stuck if no click comes.
	let suppressClick = false;
	let suppressClickTimer: ReturnType<typeof setTimeout> | null = null;
	function suppressNextClick(): void {
		suppressClick = true;
		if (suppressClickTimer !== null) clearTimeout(suppressClickTimer);
		suppressClickTimer = setTimeout(() => {
			suppressClick = false;
			suppressClickTimer = null;
		}, 400);
	}

	// Surface a transient recording error (mic denied, Baseten unreachable, daemon
	// "not ready") as a brief toast — no silent failure, no backend switch.
	function showVoiceError(message: string): void {
		voiceError = message;
		if (voiceErrorTimer !== null) clearTimeout(voiceErrorTimer);
		voiceErrorTimer = setTimeout(() => {
			voiceError = null;
			voiceErrorTimer = null;
		}, 4000);
	}

	// All writes to voicePhase route through this so TS doesn't narrow it to a
	// literal across the awaits in beginRecording — it's $state the gesture mutates
	// concurrently with mic-permission / connection setup.
	function setVoicePhase(p: 'idle' | 'recording' | 'draining'): void {
		voicePhase = p;
	}

	// Non-reactive gesture bookkeeping.
	let voiceSession: VoiceSession | null = null;
	// Generation counter for the gesture: bumped on every beginRecording and every
	// resetVoice. Session callbacks (onError/onClosed) and the post-await resume
	// check compare against it so a LATE callback from a previous session — e.g.
	// its WS closing after the user already started a new dictation, or a failed
	// stop POST reporting after the FSM reset — can never reset the new gesture.
	let voiceGeneration = 0;
	// True once the VoiceSession promise has resolved for the current gesture. The
	// ✓/✗ buttons are disabled until then: before the session exists a ✓ tap could
	// only no-op the send while resetting the FSM, after which the late-resolving
	// session got disposed — i.e. the user pressed SEND and the system ran CANCEL.
	// (The window is one microtask on the /voice backend but spans the whole
	// mic-permission prompt on Baseten.)
	let voiceSessionReady = $state(false);
	let holdTimer: ReturnType<typeof setTimeout> | null = null;
	let drainTimer: ReturnType<typeof setTimeout> | null = null;
	let pointerStartX = 0;
	let pointerStartY = 0;
	let pointerIsResume = false; // this press is a resume-hold during a drain
	let capturedEl: Element | null = null;
	let capturedPointerId = -1;
	let beepCtx: AudioContext | null = null;

	function isVoiceActive(ticket: Ticket): boolean {
		return voicePhase !== 'idle' && voiceTicketId === ticket.session_id;
	}

	// The dock layout is held still (incoming SSE snapshots buffered) while a gesture
	// is in flight — a voice recording/review OR a detach drag — so a ticket can't
	// reorder out from under the finger.
	function layoutFrozen(): boolean {
		return voicePhase !== 'idle' || dragId !== null;
	}

	function flushPendingTickets(): void {
		if (pendingTickets) {
			tickets = pendingTickets;
			pendingTickets = null;
		}
	}

	function clearHoldTimer(): void {
		if (holdTimer !== null) {
			clearTimeout(holdTimer);
			holdTimer = null;
		}
	}
	function clearDrainTimer(): void {
		if (drainTimer !== null) {
			clearTimeout(drainTimer);
			drainTimer = null;
		}
	}

	function releaseCapture(): void {
		if (capturedEl && capturedPointerId >= 0) {
			try {
				capturedEl.releasePointerCapture(capturedPointerId);
			} catch {
				/* capture already gone */
			}
		}
		capturedEl = null;
		capturedPointerId = -1;
	}

	// Minimal WebAudio beeps for start/sent (OQ4 defaults). The hold is a user
	// gesture, so creating/resuming the context on first use satisfies autoplay.
	function beep(freq: number, durMs: number, when = 0): void {
		if (!browser) return;
		try {
			beepCtx ??= new AudioContext();
			if (beepCtx.state === 'suspended') void beepCtx.resume();
			const t0 = beepCtx.currentTime + when;
			const osc = beepCtx.createOscillator();
			const gain = beepCtx.createGain();
			osc.type = 'sine';
			osc.frequency.value = freq;
			gain.gain.setValueAtTime(0.0001, t0);
			gain.gain.exponentialRampToValueAtTime(0.16, t0 + 0.012);
			gain.gain.exponentialRampToValueAtTime(0.0001, t0 + durMs / 1000);
			osc.connect(gain).connect(beepCtx.destination);
			osc.start(t0);
			osc.stop(t0 + durMs / 1000 + 0.02);
		} catch {
			/* audio unavailable — sound is non-essential */
		}
	}
	const playStartSound = (): void => beep(660, 90);
	const playSentSound = (): void => {
		beep(880, 70);
		beep(1175, 90, 0.08);
	};

	async function fetchVoiceBackend(): Promise<void> {
		if (!clientToken) return;
		try {
			const res = await fetch('/api/voice/config', {
				headers: { 'x-expediter-token': clientToken }
			});
			if (!res.ok) return;
			const data = (await res.json()) as { backend?: string };
			if (data.backend === 'baseten' || data.backend === 'voice') sttBackend = data.backend;
		} catch {
			/* keep the default backend */
		}
	}

	// Settings UI (6.1): persist the backend choice. Optimistic — revert on failure.
	async function setBackend(b: VoiceBackend): Promise<void> {
		if (!clientToken || b === sttBackend) return;
		const prev = sttBackend;
		sttBackend = b;
		try {
			const res = await fetch('/api/voice/config', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'x-expediter-token': clientToken },
				body: JSON.stringify({ backend: b })
			});
			if (!res.ok) sttBackend = prev;
		} catch {
			sttBackend = prev;
		}
	}

	function resetVoice(dispose = false): void {
		voiceGeneration++;
		clearHoldTimer();
		clearDrainTimer();
		if (dispose) voiceSession?.dispose();
		voiceSession = null;
		voiceSessionReady = false;
		setVoicePhase('idle');
		voiceTicketId = null;
		pointerIsResume = false;
		// Gesture over — apply any SSE snapshot we held back so the dock catches up.
		flushPendingTickets();
	}

	async function beginRecording(ticket: Ticket): Promise<void> {
		if (!clientToken) return;
		const gen = ++voiceGeneration;
		voiceTicketId = ticket.session_id;
		voiceSessionReady = false;
		setVoicePhase('recording');
		playStartSound();
		try {
			const session = await startVoiceSession(
				{ backend: sttBackend, pane: ticket.tmux_pane, token: clientToken },
				{
					onError: (m) => {
						// Always surface the failure; only reset the FSM if this session
						// is still the live gesture (a failed stop POST reports after the
						// reset, and must not knock over the NEXT recording).
						showVoiceError(m);
						if (gen === voiceGeneration) resetVoice(true);
					},
					onClosed: () => {
						// The session died underneath the gesture (daemon restart, network
						// change, phone backgrounded). The session has already disposed
						// itself — reset the FSM so the dock stops pulsing on a corpse and
						// a later ✓ can't fake a send.
						if (gen !== voiceGeneration) return;
						showVoiceError('recording connection lost');
						resetVoice(false);
					}
				}
			);
			// The user may have released/cancelled (or an error reset us) while mic
			// access was being granted — any path back through resetVoice bumped the
			// generation, so a mismatch means this session is orphaned.
			if (gen !== voiceGeneration) {
				session.dispose();
				return;
			}
			voiceSession = session;
			voiceSessionReady = true;
			// If they released into the drain during the await, honor it now.
			if (voicePhase === 'draining') session.release();
		} catch {
			showVoiceError('microphone unavailable');
			if (gen === voiceGeneration) resetVoice(true);
		}
	}

	function startDrain(): void {
		// Release → "review": recording stops but NOTHING sends on its own. The user
		// taps ✓ to send or ✗ to discard (or holds again to resume). No timer.
		setVoicePhase('draining');
		clearDrainTimer();
	}

	function enterDrain(): void {
		voiceSession?.release();
		startDrain();
	}

	function doResume(): void {
		clearDrainTimer();
		voiceSession?.resume();
		setVoicePhase('recording');
	}

	function doSend(): void {
		// No session yet (still resolving) or already gone → there is nothing to
		// send; doing the feedback-and-reset anyway is how a ✓ used to lie. The
		// buttons are disabled until voiceSessionReady, this is the race belt.
		if (!voiceSession) return;
		clearDrainTimer();
		voiceSession.send();
		playSentSound();
		resetVoice(false);
	}

	function doCancel(): void {
		if (!voiceSession) return;
		clearDrainTimer();
		voiceSession.cancel();
		resetVoice(false);
	}

	function onTicketPointerDown(ticket: Ticket, e: PointerEvent): void {
		if (!e.isPrimary) return;
		pointerStartX = e.clientX;
		pointerStartY = e.clientY;
		try {
			(e.currentTarget as Element).setPointerCapture(e.pointerId);
			capturedEl = e.currentTarget as Element;
			capturedPointerId = e.pointerId;
		} catch {
			/* capture unsupported — gesture still works, just less robust */
		}

		if (voicePhase === 'draining' && voiceTicketId === ticket.session_id) {
			// Tap-and-hold during the drain → resume. Pause the auto-send meanwhile.
			pointerIsResume = true;
			clearDrainTimer();
			holdTimer = setTimeout(() => {
				holdTimer = null;
				doResume();
			}, HOLD_MS);
			return;
		}
		if (voicePhase !== 'idle') return; // a recording is active elsewhere — ignore
		pointerIsResume = false;
		holdTimer = setTimeout(() => {
			holdTimer = null;
			void beginRecording(ticket);
		}, HOLD_MS);
	}

	function onTicketPointerMove(e: PointerEvent): void {
		// Only the pre-threshold hold is movement-cancellable; once recording, drift
		// is fine (you may shift your grip while talking).
		if (holdTimer === null) return;
		const dx = e.clientX - pointerStartX;
		const dy = e.clientY - pointerStartY;
		if (dx * dx + dy * dy > SLOP * SLOP) {
			clearHoldTimer();
			// A moved resume-hold reverts to a scroll; keep the drain running.
			if (pointerIsResume) startDrain();
		}
	}

	function onTicketPointerUp(ticket: Ticket, e: PointerEvent): void {
		void e;
		releaseCapture();
		if (voicePhase === 'recording' && voiceTicketId === ticket.session_id) {
			// Long-press release → drain. Swallow the click that follows so it doesn't
			// also fire focus/attach (the onclick handler owns the tap path).
			suppressNextClick();
			enterDrain();
			return;
		}
		if (holdTimer !== null) {
			// Released before the hold armed. A plain tap falls through to onclick
			// (focus/attach); a stray short press during a drain just keeps the drain
			// going and must not also tap.
			clearHoldTimer();
			if (pointerIsResume) {
				suppressNextClick();
				startDrain();
			}
		}
	}

	function onTicketPointerCancel(): void {
		releaseCapture();
		clearHoldTimer();
		// Browser claimed the gesture (scroll). Abort only, never confirm: discard an
		// in-progress recording rather than sending it. Unlike the ✗ button this can
		// fire BEFORE the session resolves — reset unconditionally; the post-await
		// generation check in beginRecording disposes the orphaned session.
		if (voicePhase === 'recording') {
			clearDrainTimer();
			voiceSession?.cancel();
			resetVoice(false);
		}
	}

	// Android Chrome's long-press context menu isn't covered by the CSS callout
	// suppression, so cancel it explicitly on the ticket.
	function onTicketContextMenu(e: Event): void {
		e.preventDefault();
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
		// Detached cards are uniform grey with no age-fade (see .ticket.detached).
		if (ticket.attached === false) return '';
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

	async function stopVoice(): Promise<void> {
		const ctl = voiceCtl;
		voiceCtl = null;
		voiceState = 'idle';
		voiceDetail = '';
		if (ctl) {
			try {
				await ctl.hangUp();
			} catch {
				/* already torn down */
			}
		}
	}

	async function toggleVoice(): Promise<void> {
		if (!clientToken) return;
		// Live or mid-connect → hang up. Otherwise start a fresh session.
		if (voiceState === 'live' || voiceState === 'connecting') {
			await stopVoice();
			return;
		}
		voiceDetail = '';
		voiceState = 'connecting';
		try {
			const { startVoice } = await import('$lib/voice');
			voiceCtl = await startVoice({
				clientToken,
				onState: (s, d) => {
					voiceState = s;
					if (d) voiceDetail = d;
				}
			});
		} catch {
			// startVoice already reported the specific reason via onState (which set a
			// detail message); ensure the button lands in the error state regardless.
			voiceCtl = null;
			voiceState = 'error';
		}
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
		// Tear down any in-progress dictation (mic stream / WS / audio context).
		resetVoice(true);
		// Hang up any live tap-to-talk session with the orchestrator.
		if (voiceCtl) {
			void voiceCtl.hangUp().catch(() => {});
			voiceCtl = null;
		}
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
					class="voice"
					class:connecting={voiceState === 'connecting'}
					class:live={voiceState === 'live'}
					class:error={voiceState === 'error'}
					aria-label="Talk to orchestrator"
					aria-pressed={voiceState === 'live'}
					title={voiceDetail || 'Talk to orchestrator'}
					onclick={toggleVoice}
				>
					🎙
				</button>
			{/if}
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
			<div class="settings-section">
				<span class="settings-section-label">Voice backend</span>
				<div class="backend-toggle" role="group" aria-label="Speech-to-text backend">
					<button
						type="button"
						class="backend-opt"
						class:active={sttBackend === 'baseten'}
						aria-pressed={sttBackend === 'baseten'}
						onclick={() => setBackend('baseten')}
					>
						Baseten
					</button>
					<button
						type="button"
						class="backend-opt"
						class:active={sttBackend === 'voice'}
						aria-pressed={sttBackend === 'voice'}
						onclick={() => setBackend('voice')}
					>
						/voice
					</button>
				</div>
			</div>
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
	{:else}
		{#key pageIndex}
			<div class="page" in:fly={{ x: pageDir * 44, duration: 200 }}>
				<ul class="queue" class:disconnected={isDisconnected}>
					{#each visibleTickets as ticket (ticket.session_id)}
						<li
							class="ticket {typeClass(ticket.event_type)} {staleClass(ticket, now)}"
							class:pressing={focusing === ticket.session_id || attaching[ticket.session_id]}
							class:working={ticket.working}
							class:tapped={lastTapped === ticket.session_id}
							class:detached={ticket.attached === false}
							style={cardStyle(ticket)}
							class:recording={voicePhase === 'recording' && voiceTicketId === ticket.session_id}
							class:draining={voicePhase === 'draining' && voiceTicketId === ticket.session_id}
							animate:flip={{ duration: 220 }}
							in:fly|local={{ y: -8, duration: 180 }}
							out:fly|local={{ y: 8, duration: 140 }}
							ontouchstart={(e) => onCardTouchStart(e, ticket)}
							ontouchmove={(e) => onCardTouchMove(e, ticket)}
							ontouchend={() => onCardTouchEnd(ticket)}
							ontouchcancel={() => onCardTouchEnd(ticket)}
						>
							<button
								type="button"
								onclick={() => {
									if (dragMoved) {
										dragMoved = false;
										return;
									}
									if (suppressClick) {
										suppressClick = false;
										return;
									}
									onTicketTap(ticket);
								}}
								onpointerdown={(e) => onTicketPointerDown(ticket, e)}
								onpointermove={onTicketPointerMove}
								onpointerup={(e) => onTicketPointerUp(ticket, e)}
								onpointercancel={onTicketPointerCancel}
								oncontextmenu={onTicketContextMenu}
								onkeydown={(e) => {
									if (e.key === 'Enter' || e.key === ' ') {
										e.preventDefault();
										onTicketTap(ticket);
									}
								}}
							>
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

							{#if isVoiceActive(ticket)}
								<!-- Recording UI. The ticket turns orange-red via CSS vars
								     (.recording/.draining) — no overlay, so the perforation notch stays
								     cut out. The indicator is a recording PULSE, not a live waveform: the
								     phone can't measure /voice's audio (you speak at the laptop), so faking
								     amplitude is meaningless. Release shows ✓ send / ✗ discard — nothing
								     auto-sends. -->
								{#if voicePhase === 'draining'}
									<!-- Disabled until the VoiceSession promise resolves: a ✓ on a
									     not-yet-existing session can't send anything, and resetting the
									     FSM on it turned the user's SEND into a CANCEL (the orphaned
									     session gets disposed when it finally resolves). -->
									<button
										type="button"
										class="voice-send"
										aria-label="Send dictation"
										disabled={!voiceSessionReady}
										onclick={doSend}>✓</button
									>
									<button
										type="button"
										class="voice-cancel"
										aria-label="Discard dictation"
										disabled={!voiceSessionReady}
										onclick={doCancel}>✕</button
									>
								{:else}
									<div class="voice-indicator" aria-hidden="true">
										<span class="rec-pulse"></span>
									</div>
								{/if}
							{/if}
						</li>
					{/each}
				</ul>

				{#if visibleTickets.length === 0 && !isDisconnected}
					<div class="empty page-empty" aria-live="polite">
						{#if page === 'attached'}
							<span class="dot"></span>
							<span class="empty-label">You have zero tickets!</span>
						{:else}
							<span class="empty-label">No detached sessions</span>
						{/if}
					</div>
				{/if}
			</div>
		{/key}

		{#if !isDisconnected}
			<nav class="pager" aria-label="Pages">
				<button
					type="button"
					class="pager-arrow"
					onclick={prevPage}
					disabled={pageIndex === 0}
					aria-label="Previous page"
				>
					‹
				</button>
				<span class="pager-title">{page === 'attached' ? 'Attached' : 'Detached'}</span>
				<button
					type="button"
					class="pager-arrow"
					onclick={nextPage}
					disabled={pageIndex === PAGES.length - 1}
					aria-label="Next page"
				>
					›
				</button>
			</nav>
		{/if}
	{/if}

	{#if isDisconnected}
		<div class="disconnected-overlay" role="status" aria-live="polite">
			<span>you are disconnected</span>
		</div>
	{/if}

	{#if voiceError}
		<div class="voice-error" role="status" aria-live="polite">{voiceError}</div>
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
		/* All four insets, not just top/bottom: in landscape the device notch /
		   camera moves to a side, so the left/right safe-area insets become
		   non-zero and must pad the dock clear of it. The OS reports the exact
		   inset per device and orientation (viewport-fit=cover is set in
		   app.html), so this is notch-size-agnostic — nothing is hardcoded per
		   phone. In portrait the left/right insets are ~0, so it stays at 14px. */
		padding: calc(env(safe-area-inset-top, 0) + 14px)
			calc(env(safe-area-inset-right, 0) + 14px)
			calc(env(safe-area-inset-bottom, 0) + 72px)
			calc(env(safe-area-inset-left, 0) + 14px);
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

	/* Tap-to-talk mic. Idle = desaturated/quiet; connecting pulses; live goes
	   green (matches the .conn LED); error goes the PermissionRequest red. */
	.voice {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		background: transparent;
		border: 0;
		padding: 4px;
		margin: -4px;
		font-size: 18px;
		line-height: 1;
		cursor: pointer;
		-webkit-tap-highlight-color: transparent;
		filter: grayscale(1);
		opacity: 0.5;
		transition:
			filter 150ms ease,
			opacity 150ms ease,
			transform 200ms ease;
	}
	.voice.connecting {
		filter: none;
		opacity: 1;
		animation: voice-pulse 1s ease-in-out infinite;
	}
	.voice.live {
		filter: none;
		opacity: 1;
		transform: scale(1.1);
	}
	.voice.error {
		filter: none;
		opacity: 1;
	}
	@keyframes voice-pulse {
		0%,
		100% {
			opacity: 1;
		}
		50% {
			opacity: 0.35;
		}
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
	/* Backend selector in the settings panel (6.1). A label over a two-option
	   segmented toggle, styled to sit above the destructive shutdown action. */
	.settings-section {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 14px 16px 10px;
	}
	.settings-section-label {
		font-size: 11px;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: rgba(42, 31, 21, 0.5);
	}
	.backend-toggle {
		display: flex;
		gap: 4px;
		background: rgba(201, 189, 154, 0.22);
		border-radius: 3px;
		padding: 3px;
	}
	.backend-opt {
		flex: 1;
		background: transparent;
		border: 0;
		color: #6b5a3a;
		font: inherit;
		font-size: 13px;
		letter-spacing: 0.04em;
		padding: 8px 10px;
		border-radius: 2px;
		cursor: pointer;
		-webkit-tap-highlight-color: transparent;
		transition:
			background 120ms ease,
			color 120ms ease;
	}
	.backend-opt.active {
		background: #fffdf5;
		color: #2a1f15;
		font-weight: 600;
		box-shadow: 0 1px 3px rgba(80, 60, 30, 0.18);
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

	/* Page wrapper for the Attached/Detached slide transition. Fills the space
	   between the header and the fixed pager (flex: 1) and stacks its queue +
	   empty state in a column, so the empty state still centers and the whole
	   page can fly horizontally as one unit on a page switch. */
	.page {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
		gap: 16px;
	}

	.queue {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 16px;
		transition: opacity 1.2s ease;
		/* Promote the list to its own compositing layer. On iOS WebKit, animating
		   this container's opacity while its children carry filter() (the stale /
		   idle saturate() tints) can fail to repaint — the tickets stay painted at
		   their old opacity even though the value is already 0, so the disconnect
		   fade visually never happens. Owning a layer makes the opacity composite
		   over the whole subtree at once, so the fade actually renders. */
		will-change: opacity;
		transform: translateZ(0);
	}
	/* In landscape the dock has width to spare, so the single column reflows
	   into two. Pure layout swap on .queue — tickets are grid items that flow
	   row-major (highest-priority top-left), gap carries over, and the flip/fly
	   transitions, disconnect fade, and per-ticket perforation are all
	   unaffected. No rotation, so main's safe-area padding stays correct. */
	@media (orientation: landscape) {
		.queue {
			display: grid;
			grid-template-columns: 1fr 1fr;
		}
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
		/* Vertical scroll stays native; horizontal is the detach drag's to handle,
		   so we never need a non-passive preventDefault on touchmove. */
		touch-action: pan-y;
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
		--bg: rgba(255, 241, 201, 0.2);
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
	/* Detached cards: uniform grey, overriding the per-event-type palette AND the
	   never-grey PermissionRequest rule — a detached session is parked, so it reads
	   as inactive regardless of its last event. saturate(0) over the default
	   ticket palette yields one consistent grey; staleClass already returns '' for
	   detached, so there is no additional age-fade. Placed after .type-*, .stale-*,
	   and .working so it wins on equal specificity via source order. */
	.ticket.detached {
		filter: saturate(0);
		--bg: #fff1c9;
		--border: #ead68f;
		--title: #2a1f15;
		--muted: #8a7a45;
		--accent: #6e5a20;
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
		/* Long-press gesture suppression (5.1): keep vertical dock scroll (pan-y) but
		   kill the iOS callout/text-magnifier and Android selection so a hold reads as
		   our gesture, not a browser one. touch-action: pan-y also makes the browser
		   fire pointercancel when a vertical scroll starts, which the FSM treats as an
		   abort. The Android long-press menu needs the contextmenu preventDefault in
		   JS as well — the callout property doesn't cover it. */
		-webkit-touch-callout: none;
		-webkit-user-select: none;
		user-select: none;
		touch-action: pan-y;
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
		border: 1px solid var(--border);
		border-left: 0;
	}
	.perforation::after {
		right: calc(-1 * var(--notch-offset) - 1px);
		border-radius: var(--notch-size) 0 0 var(--notch-size);
		border: 1px solid var(--border);
		border-right: 0;
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

	/* Bottom pager: a fixed bar that switches the Attached / Detached pages.
	   Centered page title with a minimal arrow on each side; no swipe. Translucent
	   blurred background so dock content scrolls underneath. Hidden while
	   disconnected (the overlay takes over); main reserves bottom padding so the
	   last card never hides behind it. */
	.pager {
		position: fixed;
		left: 0;
		right: 0;
		bottom: 0;
		z-index: 15;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 22px;
		padding: 10px calc(env(safe-area-inset-right, 0) + 14px)
			calc(env(safe-area-inset-bottom, 0) + 10px)
			calc(env(safe-area-inset-left, 0) + 14px);
		background: rgba(255, 253, 245, 0.92);
		-webkit-backdrop-filter: blur(8px);
		backdrop-filter: blur(8px);
	}
	.pager-title {
		flex: 1;
		text-align: center;
		font-size: 13px;
		font-weight: 600;
		letter-spacing: 0.18em;
		text-transform: uppercase;
		color: #2a1f15;
	}
	.pager-arrow {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 40px;
		min-height: 36px;
		background: transparent;
		border: 0;
		color: #2a1f15;
		font-size: 22px;
		line-height: 1;
		cursor: pointer;
		-webkit-tap-highlight-color: transparent;
		transition: opacity 150ms ease;
	}
	.pager-arrow:disabled {
		opacity: 0.22;
		cursor: default;
	}

	/* ─── Speech-to-prompt recording UI (Phase 5) ───────────────────────────── */

	/* Recording / draining ticket: turn the whole card orange-red via the SAME CSS
	   variables the working/permission states use — not an overlay — so the
	   perforation notch (var(--page-bg)) stays cut out. filter:none defeats the
	   idle/detached/stale saturate(0) that otherwise greyed the card. Raised and
	   above its neighbors; placed after .working/.detached so it wins on source order. */
	.ticket.recording,
	.ticket.draining {
		--bg: #ff5436;
		--border: #e23d1f;
		--title: #fff4f0;
		--muted: #ffd7cc;
		--accent: #ffffff;
		filter: none;
		transform: translateY(-3px) scale(1.012);
		box-shadow: 0 6px 18px rgba(150, 50, 20, 0.3);
		z-index: 3;
	}

	/* Right-end indicator circle holding a recording PULSE — a status light, not a
	   waveform (the phone can't measure /voice's laptop-side audio, so live amplitude
	   would be fake). pointer-events:none so the hold gesture passes through. */
	.voice-indicator {
		position: absolute;
		top: 50%;
		right: 14px;
		transform: translateY(-50%);
		z-index: 2;
		box-sizing: border-box;
		width: 34px;
		height: 34px;
		border-radius: 50%;
		background: rgba(255, 253, 245, 0.95);
		box-shadow: 0 1px 5px rgba(120, 40, 20, 0.32);
		display: flex;
		align-items: center;
		justify-content: center;
		pointer-events: none;
	}
	.voice-indicator .rec-pulse {
		width: 12px;
		height: 12px;
		border-radius: 50%;
		background: #d33a1c;
		animation: rec-pulse 1.1s ease-in-out infinite;
	}
	@keyframes rec-pulse {
		0%,
		100% {
			opacity: 1;
			transform: scale(1);
		}
		50% {
			opacity: 0.35;
			transform: scale(0.6);
		}
	}

	/* Review state: explicit Send (✓) and Discard (✗) buttons — nothing auto-sends.
	   Scoped `.ticket button.voice-*` so they OUT-SPECIFY `.ticket button { width:100% }`
	   (which was stretching them into ovals) and override its block/left-align/
	   transparent. Fixed-size clean circles; Send sits to the left of Discard. */
	.ticket button.voice-send,
	.ticket button.voice-cancel {
		position: absolute;
		top: 50%;
		transform: translateY(-50%);
		z-index: 3;
		box-sizing: border-box;
		width: 34px;
		height: 34px;
		padding: 0;
		border: 0;
		border-radius: 50%;
		font-size: 18px;
		line-height: 1;
		text-align: center;
		cursor: pointer;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		box-shadow: 0 1px 5px rgba(120, 40, 20, 0.32);
		-webkit-tap-highlight-color: transparent;
	}
	.ticket button.voice-send {
		right: 56px;
		background: #2f7d31;
		color: #fff;
	}
	.ticket button.voice-cancel {
		right: 14px;
		background: rgba(255, 253, 245, 0.97);
		color: #b3301a;
	}
	/* Session still resolving (mic permission up, WS connecting) — the buttons
	   exist but can't act yet, so read as inert rather than ignoring taps. */
	.ticket button.voice-send:disabled,
	.ticket button.voice-cancel:disabled {
		opacity: 0.45;
		cursor: default;
	}

	/* Transient recording-error toast (mic denied / Baseten unreachable / not
	   ready). Sits just above the pager; auto-clears after 4s. */
	.voice-error {
		position: fixed;
		left: 50%;
		bottom: calc(env(safe-area-inset-bottom, 0) + 64px);
		transform: translateX(-50%);
		z-index: 16;
		max-width: calc(100vw - 40px);
		padding: 10px 16px;
		background: #8b2e1f;
		color: #fff;
		font-size: 12px;
		letter-spacing: 0.06em;
		border-radius: 2px;
		box-shadow: 0 4px 14px rgba(80, 20, 10, 0.3);
		animation: voice-error-in 160ms ease both;
	}
	@keyframes voice-error-in {
		from {
			opacity: 0;
			transform: translate(-50%, 6px);
		}
		to {
			opacity: 1;
			transform: translate(-50%, 0);
		}
	}
</style>
