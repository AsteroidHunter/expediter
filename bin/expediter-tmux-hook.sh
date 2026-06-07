#!/usr/bin/env bash
# expediter-tmux-hook.sh — pings the Expediter daemon to re-check tmux attach
# state. The daemon wires this at boot via
#   tmux set-hook -g client-attached  'run-shell -b "<this script>"'
#   tmux set-hook -g client-detached  'run-shell -b "<this script>"'
#
# Carries NO payload: tmux's per-client hook events are version-quirky, so the
# daemon re-queries tmux truth and reconciles rather than trusting the event.
# This script just nudges the daemon. Mirrors expediter-hook.sh's transport
# (scheme from config.json, -k on HTTPS, -m 2 timeout, DEBUG_HOOK-gated warning)
# and ALWAYS exits 0 so a daemon outage never surfaces as a tmux hook error.

set -u

PORT="${EXPEDITER_PORT:-5179}"

# Match the daemon's transport. The launcher writes {"transport":"http"} to
# config.json when the user opts out of HTTPS; absent (or anything else) means
# the default, HTTPS. Cheap grep -- this runs on every hook event, so no python/jq.
SCHEME="https"
CONFIG_FILE="${HOME}/.expediter/config.json"
if [ -f "$CONFIG_FILE" ] && grep -q '"transport"[[:space:]]*:[[:space:]]*"http"' "$CONFIG_FILE" 2>/dev/null; then
	SCHEME="http"
fi

# curl -w '%{http_code}' prints "000" on connection failure (and exits non-zero,
# which the assignment swallows), so STATUS is the daemon's HTTP code or "000"
# when it is unreachable. No body is sent — the endpoint ignores it.
# -k on HTTPS: the daemon serves a locally-generated cert that isn't in the Mac's
# trust store. This is a loopback POST to our own daemon, so skipping verification
# is safe and avoids a curl CA dance.
INSECURE=""
if [ "$SCHEME" = "https" ]; then INSECURE="-k"; fi
STATUS=$(curl -s -o /dev/null -m 2 -w '%{http_code}' $INSECURE \
	-X POST "${SCHEME}://localhost:${PORT}/api/tmux-event" 2>/dev/null)

if [ -n "${DEBUG_HOOK:-}" ] && [[ "$STATUS" != 2* ]]; then
	echo "[tmux-hook] daemon returned HTTP $STATUS for /api/tmux-event" >&2
fi

exit 0
