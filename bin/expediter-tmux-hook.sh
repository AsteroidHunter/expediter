#!/usr/bin/env bash
# expediter-tmux-hook.sh — pings the Expediter daemon to re-check tmux attach
# state. The daemon wires this at boot via
#   tmux set-hook -g client-attached  'run-shell -b "<this script>"'
#   tmux set-hook -g client-detached  'run-shell -b "<this script>"'
#
# Carries NO payload: tmux's per-client hook events are version-quirky, so the
# daemon re-queries tmux truth and reconciles rather than trusting the event.
# This script just nudges the daemon. Mirrors expediter-hook.sh's transport
# (plain HTTP on localhost, -m 2 timeout, DEBUG_HOOK-gated warning) and ALWAYS
# exits 0 so a daemon outage never surfaces as a tmux hook error.

set -u

PORT="${EXPEDITER_PORT:-5179}"

# curl -w '%{http_code}' prints "000" on connection failure (and exits non-zero,
# which the assignment swallows), so STATUS is the daemon's HTTP code or "000"
# when it is unreachable. No body is sent — the endpoint ignores it.
STATUS=$(curl -s -o /dev/null -m 2 -w '%{http_code}' \
	-X POST "http://localhost:${PORT}/api/tmux-event" 2>/dev/null)

if [ -n "${DEBUG_HOOK:-}" ] && [[ "$STATUS" != 2* ]]; then
	echo "[tmux-hook] daemon returned HTTP $STATUS for /api/tmux-event" >&2
fi

exit 0
