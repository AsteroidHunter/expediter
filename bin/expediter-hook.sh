#!/usr/bin/env bash
# expediter-hook.sh — bridges a Claude Code hook event into the Expediter daemon.
#
# Usage (from ~/.claude/settings.json):
#   /path/to/expediter-hook.sh <EVENT_NAME>
#
# Reads the Claude Code hook JSON payload on stdin, POSTs to the daemon, and
# ALWAYS exits 0 so a daemon outage never surfaces as "hook error" in the
# terminal and Stop never accidentally returns exit 2 (which tells Claude
# "don't stop, keep going" and would loop the agent back in).
#
# One script, two modes:
#   local  — $TMUX_PANE set (claude runs in a local tmux pane): inject the
#            pane id, POST to the local daemon. Unchanged original behavior.
#   remote — $TMUX_PANE unset but $SSH_CONNECTION set (claude runs on a
#            remote box, reached from a local tmux pane via ssh): inject
#            remote:true, the verbatim $SSH_CONNECTION (the Mac daemon
#            resolves the local pane from its client port — see
#            src/lib/server/sshCorrelation.ts), and the latest custom-title
#            from this box's own transcript, which the Mac cannot read. The
#            POST goes to localhost:5179 exactly as in local mode; the
#            installer-written RemoteForward tunnel carries it to the Mac.

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

# Mode selection. Inside tmux → local (the pane id travels in the payload).
# No pane but an ssh session → remote ($SSH_CONNECTION travels instead; sshd
# sets it unconditionally, zero config). Neither → Claude Code launched
# outside both topologies; a ticket would be unfocusable — bail silently.
if [ -n "${TMUX_PANE:-}" ]; then
	MODE="local"
elif [ -n "${SSH_CONNECTION:-}" ]; then
	MODE="remote"
else
	exit 0
fi

# Re-emit Claude Code's JSON payload with the mode's identity fields added and
# (defensively) hook_event_name set from $1. Uses python3 -c (not
# python3 - <<HEREDOC, which would attach the heredoc as python's stdin and
# steal Claude Code's JSON) so the original piped stdin reaches
# sys.stdin.read(). In remote mode the same python process also backward-scans
# this box's transcript (the path Claude passed in the stdin JSON) for the
# latest custom-title line — mirroring the daemon's latestCustomTitle
# (src/lib/transcript.ts) — because the Mac cannot read a remote transcript;
# the field is omitted when no title exists yet.
PAYLOAD=$(python3 -c '
import json, os, sys
try:
    raw = sys.stdin.read()
    data = json.loads(raw) if raw.strip() else {}
except Exception:
    data = {}
if not isinstance(data, dict):
    data = {}
mode = sys.argv[2] if len(sys.argv) > 2 else "local"
if mode == "remote":
    data["remote"] = True
    data["ssh_connection"] = os.environ.get("SSH_CONNECTION", "")
    tp = data.get("transcript_path")
    if isinstance(tp, str) and tp:
        try:
            with open(tp, "rb") as f:
                lines = f.read().decode("utf-8", "replace").splitlines()
            for line in reversed(lines):
                line = line.strip()
                if not line:
                    continue
                try:
                    parsed = json.loads(line)
                except Exception:
                    continue
                if not isinstance(parsed, dict) or parsed.get("type") != "custom-title":
                    continue
                title = parsed.get("customTitle")
                if isinstance(title, str) and title.strip():
                    data["title"] = title.strip()
                    break
        except Exception:
            pass
else:
    data["tmux_pane"] = os.environ.get("TMUX_PANE", "")
event_name = sys.argv[1] if len(sys.argv) > 1 else ""
if event_name:
    data["hook_event_name"] = event_name
sys.stdout.write(json.dumps(data))
' "$EVENT" "$MODE" 2>/dev/null) || PAYLOAD=""

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
