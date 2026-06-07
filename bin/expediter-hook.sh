#!/usr/bin/env bash
# expediter-hook.sh — bridges a Claude Code hook event into the Expediter daemon.
#
# Usage (from ~/.claude/settings.json):
#   /path/to/expediter-hook.sh <EVENT_NAME>
#
# Reads the Claude Code hook JSON payload on stdin, injects $TMUX_PANE
# (inherited from the tmux pane that launched Claude Code), POSTs to the
# daemon, and ALWAYS exits 0 so a daemon outage never surfaces as "hook error"
# in the terminal and Stop never accidentally returns exit 2 (which tells
# Claude "don't stop, keep going" and would loop the agent back in).

set -u

EVENT="${1:-}"
PORT="${EXPEDITER_PORT:-5179}"

# Match the daemon's transport. The launcher writes {"transport":"http"} to
# config.json when the user opts out of HTTPS; absent (or anything else) means
# the default, HTTPS. Cheap grep -- this runs on every hook event, so no python/jq.
SCHEME="https"
CONFIG_FILE="${HOME}/.expediter/config.json"
if [ -f "$CONFIG_FILE" ] && grep -q '"transport"[[:space:]]*:[[:space:]]*"http"' "$CONFIG_FILE" 2>/dev/null; then
	SCHEME="http"
fi

# Standing assumption: Claude Code always runs inside tmux. If TMUX_PANE is
# empty (Claude Code launched outside tmux despite the hard requirement), we
# would produce an unfocusable ticket — bail silently instead.
if [ -z "${TMUX_PANE:-}" ]; then
	exit 0
fi

# Re-emit Claude Code's JSON payload with tmux_pane added and (defensively)
# hook_event_name set from $1. Uses python3 -c (not python3 - <<HEREDOC,
# which would attach the heredoc as python's stdin and steal Claude Code's
# JSON) so the original piped stdin reaches sys.stdin.read().
PAYLOAD=$(python3 -c '
import json, os, sys
try:
    raw = sys.stdin.read()
    data = json.loads(raw) if raw.strip() else {}
except Exception:
    data = {}
if not isinstance(data, dict):
    data = {}
data["tmux_pane"] = os.environ.get("TMUX_PANE", "")
event_name = sys.argv[1] if len(sys.argv) > 1 else ""
if event_name:
    data["hook_event_name"] = event_name
sys.stdout.write(json.dumps(data))
' "$EVENT" 2>/dev/null) || PAYLOAD=""

if [ -n "$PAYLOAD" ]; then
	# /api/hooks/event is loopback-trusted at the gate (see hooks.server.ts), so
	# we don't fetch or send the daemon's session token from here. Capture the
	# HTTP status into a variable so a DEBUG_HOOK-gated warning can surface
	# daemon-down (000) or future-tightening (403) failures without surfacing as
	# a Claude Code hook error in the user's terminal.
	# curl -w '%{http_code}' prints "000" on connection failure (and still
	# exits non-zero), so a `|| echo 000` fallback would concatenate "000000".
	# Just let the assignment swallow curl's exit status — STATUS will be the
	# "000" curl emits if the daemon is unreachable.
	# -k on HTTPS: the daemon serves a locally-generated cert that isn't in the
	# Mac's trust store. This is a loopback POST to our own daemon, so skipping
	# verification is safe and avoids a curl CA dance.
	INSECURE=""
	if [ "$SCHEME" = "https" ]; then INSECURE="-k"; fi
	STATUS=$(curl -s -o /dev/null -m 2 -w '%{http_code}' $INSECURE \
		-X POST "${SCHEME}://localhost:${PORT}/api/hooks/event" \
		-H 'Content-Type: application/json' \
		-d "$PAYLOAD" 2>/dev/null)
	if [ -n "${DEBUG_HOOK:-}" ] && [[ "$STATUS" != 2* ]]; then
		echo "[hook] daemon returned HTTP $STATUS for /api/hooks/event" >&2
	fi
fi

exit 0
