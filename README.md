# Expediter

A phone-based attention queue for Claude Code sessions.

The phone — clamped beside the monitor and connected to the laptop via USB-C — runs a PWA showing a vertical list of tickets. A ticket exists only when a Claude Code session is waiting on you (asked a question, needs a permission, finished a turn). Empty list = nothing demands attention. Tap a ticket to bring Terminal.app to the foreground and switch tmux to the right window.

Status: v0 in progress. See `expediterwiki/plans/expediter-v0-build/` for the build plan.

## Stack

- SvelteKit on Bun
- Server-Sent Events for live push
- Claude Code hooks for event ingestion
- tmux + `osascript` for tap-to-focus
- PWA (Add-to-Home-Screen) on the phone
- USB-C tether for the private network

## Requirements

- macOS with Terminal.app
- tmux (hard requirement — Claude Code must run inside a tmux session)
- Bun 1.3+
- `ANTHROPIC_API_KEY` env var (used by the daemon for caveman-style ticket titles)
- Phone: iOS 18.4+ or Android with Wake Lock support

## Setup

Detailed install + USB tether walkthrough lands in Phase 7. For now, see the build plan.
