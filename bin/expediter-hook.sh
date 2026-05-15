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
	curl -s -o /dev/null -m 2 \
		-X POST "http://localhost:${PORT}/api/hooks/event" \
		-H 'Content-Type: application/json' \
		-d "$PAYLOAD" || true
fi

exit 0
