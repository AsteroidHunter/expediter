# Expediter

A phone-based attention queue for Claude Code sessions.

The phone — clamped beside the monitor and connected to the laptop via USB-C — runs a PWA showing a vertical list of tickets. A ticket exists only when a Claude Code session is waiting on you (asked a question, needs a permission, finished a turn). Empty list = nothing demands attention. Tap a ticket to bring Terminal.app to the foreground and switch tmux to the right window. v0 is read-only — no reply-from-phone surface.

```
┌──────────────────────────────────┐
│  Mac                             │
│    Terminal.app                  │
│      └─ tmux                     │
│           ├─ window 1 ───┐       │
│           ├─ window 2 ───┤ hook  │
│           └─ window 3 ───┘ POSTs │
│                          │       │
│    SvelteKit-on-Bun ◀────┘       │
│      /api/hooks/event            │
│      /api/stream  (SSE)          │
│      /api/focus                  │
└──────────────│───────────────────┘
               │  HTTP + SSE over USB tether
               ▼
┌──────────────────────────────────┐
│  iPhone (clamped + USB-powered)  │
│    Safari → PWA (Add to Home)    │
│      attention queue             │
└──────────────────────────────────┘
```

## Stack

- SvelteKit on Bun (Svelte 5 runes)
- `@anthropic-ai/sdk` calling Claude Haiku for caveman-style ticket titles
- Server-Sent Events with full-snapshot-on-connect (snapshot, not deltas — every reconnect resyncs fully)
- Claude Code hooks for event ingestion (Stop / PermissionRequest / Notification / UserPromptSubmit / PostToolUse / PostToolUseFailure / SessionEnd)
- tmux `display-message` + `select-window` and `osascript` for tap-to-focus
- PWA (Add-to-Home-Screen, dark mode, monospace, portrait)
- USB-C tether (iOS Personal Hotspot over USB) as the private network

## Hard requirements

- macOS with **Terminal.app** (other terminals would need a different AppleScript line)
- **tmux** — Claude Code must run inside a tmux session for `$TMUX_PANE` to propagate to the hook scripts
- **Bun** 1.3+ (`curl -fsSL https://bun.sh/install | bash`)
- **`ANTHROPIC_API_KEY`** — without it tickets still appear, but the title falls back to `(no api key)`
- Phone: **iOS 18.4+** (Wake Lock works in installed PWAs) or Android with Wake Lock support

## Install

```sh
# Clone
git clone https://github.com/AsteroidHunter/expediter.git
cd expediter

# Install deps
bun install

# Build the daemon (writes build/index.js)
bun run build

# Put your Anthropic key somewhere the daemon will see it.
# (NEVER commit this file — it's read by bin/expediter-daemon.sh at startup.)
mkdir -p ~/.expediter
cat > ~/.expediter/env <<'EOF'
ANTHROPIC_API_KEY=sk-ant-...
EOF
chmod 600 ~/.expediter/env

# One-time sanity run
EXPEDITER_HOST=127.0.0.1 EXPEDITER_PORT=5179 bun ./build/index.js
# → "Listening on http://127.0.0.1:5179"  (Ctrl-C to stop)
```

### Run as a LaunchAgent (recommended)

```sh
# Symlink (not copy) the plist so future repo edits propagate automatically
ln -sf "$(pwd)/etc/com.expediter.daemon.plist" \
       ~/Library/LaunchAgents/com.expediter.daemon.plist

# Load it
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.expediter.daemon.plist

# Verify
launchctl print gui/$(id -u)/com.expediter.daemon | head
tail -f ~/Library/Logs/expediter.out.log
```

The plist is a LaunchAgent, not a LaunchDaemon, because LaunchDaemons run with no GUI session and can't drive Terminal.app via AppleScript — which would break tap-to-focus. The first time you tap a ticket, macOS will show a one-time TCC Automation prompt for `bun → Terminal.app`. Click Allow.

### Wire up the Claude Code hooks

The `bin/expediter-hook.sh` script is the one-line bridge from each Claude Code hook event to the daemon. Add the following to `~/.claude/settings.json` (merge with whatever's already in `hooks:` — leave the other top-level keys alone). A copyable example is at `docs/hooks-config-example.json`.

```json
{
  "hooks": {
    "Stop": [{"matcher": "", "hooks": [{"type": "command", "command": "/PATH/TO/expediter/bin/expediter-hook.sh Stop"}]}],
    "PermissionRequest": [{"matcher": "", "hooks": [{"type": "command", "command": "/PATH/TO/expediter/bin/expediter-hook.sh PermissionRequest"}]}],
    "Notification": [{"matcher": "", "hooks": [{"type": "command", "command": "/PATH/TO/expediter/bin/expediter-hook.sh Notification"}]}],
    "UserPromptSubmit": [{"matcher": "", "hooks": [{"type": "command", "command": "/PATH/TO/expediter/bin/expediter-hook.sh UserPromptSubmit"}]}],
    "PostToolUse": [{"matcher": "", "hooks": [{"type": "command", "command": "/PATH/TO/expediter/bin/expediter-hook.sh PostToolUse"}]}],
    "PostToolUseFailure": [{"matcher": "", "hooks": [{"type": "command", "command": "/PATH/TO/expediter/bin/expediter-hook.sh PostToolUseFailure"}]}],
    "SessionEnd": [{"matcher": "", "hooks": [{"type": "command", "command": "/PATH/TO/expediter/bin/expediter-hook.sh SessionEnd"}]}]
  }
}
```

Replace `/PATH/TO/expediter` with your absolute clone path. Hooks early-exit silently when `$TMUX_PANE` is unset, so they're inert outside tmux — installing them globally won't break sessions you run outside the workflow.

### USB-C tether (the network layer)

1. **iPhone Settings → Personal Hotspot → Allow Others to Join → ON.** Plug the iPhone into the Mac via USB-C. macOS will offer "Trust this computer" the first time.
2. **Confirm a tether interface exists.**
   ```sh
   bun run tether-ip
   # http://172.20.10.1:5179/  (en7)  ← likely tether
   # http://192.168.1.155:5179/  (en0)
   ```
   The 172.20.10.x candidate is the iOS USB-Hotspot subnet — that's the URL the phone will use.
3. **Bookmark the URL on the phone.** Open Safari, navigate to the printed URL, share → Add to Home Screen. The PWA opens chromeless on iOS 26+.
4. **Disable Auto-Lock.** iPhone Settings → Display & Brightness → Auto-Lock → Never. (The PWA also calls Wake Lock, but Auto-Lock disabled is belt-and-braces.)

If macOS Application Firewall is on and the phone can connect but the page never loads, allow incoming connections for the `bun` binary in System Settings → Network → Firewall → Options.

## Development

```sh
bun run dev         # vite dev on 0.0.0.0:5179 — useful from the desktop browser
bun run check       # svelte-check
bun run build       # production build (build/index.js)
bun run tether-ip   # list candidate tether URLs
```

The daemon code lives under `src/lib/` (ticket store, summarize, transcript parser, tmux wrapper) and `src/routes/api/` (hooks/event, stream, focus). Frontend is a single `src/routes/+page.svelte`. Build plan and execution log: `expediterwiki/plans/expediter-v0-build/` (wiki is internal; not published).

## License

To be decided. For now, this is a personal project — no public license attached.
