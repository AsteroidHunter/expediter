#!/usr/bin/env bash
# expediter-hook.sh — bridges a Claude Code / Codex hook event into the
# Expediter daemon.
#
# Usage (from ~/.claude/settings.json or $CODEX_HOME/hooks.json):
#   /path/to/expediter-hook.sh <EVENT_NAME>
#
# Reads the agent's hook JSON payload on stdin (Claude Code and Codex deliver
# the same stdin-JSON contract), POSTs to the daemon, and ALWAYS exits 0 so a
# daemon outage never surfaces as "hook error" in the terminal and Stop never
# accidentally returns exit 2 (which tells the agent "don't stop, keep going"
# and would loop it back in).
#
# One script, three modes, both agents:
#   local       — $TMUX_PANE set, no $SSH_CONNECTION (the agent runs in a
#                 local tmux pane): inject the pane id, POST to the local
#                 daemon. Unchanged original behavior.
#   remote      — $SSH_CONNECTION set, no $TMUX_PANE (the agent runs on a
#                 remote box, reached from a local tmux pane via ssh): inject
#                 remote:true, the verbatim $SSH_CONNECTION (the Mac daemon
#                 resolves the local pane from its client port — see
#                 src/lib/server/sshCorrelation.ts), and this box's own chat
#                 title, which the Mac cannot read. The title source is
#                 per-agent — the one agent-specific fork in this script: a
#                 Claude transcript is scanned backward for its latest
#                 custom-title line; a Codex session's title is a one-row
#                 read of threads.title from this box's own state db (stdlib
#                 sqlite3, read-only). The POST goes to localhost:5179
#                 exactly as in local mode; the installer-written
#                 RemoteForward tunnel carries it to the Mac.
#   remote-tmux — both set (tmux runs on the remote box itself, the agent in
#                 one of its panes): like remote, plus remote_pane (this
#                 pane's id in the far-side tmux server — never shipped as
#                 tmux_pane, which is reserved for local pane ids) and
#                 ssh_connection read fresh from the tmux session environment
#                 rather than this process's frozen copy, so correlation
#                 survives detach/re-attach across ssh connections.

set -u

EVENT="${1:-}"
PORT="${EXPEDITER_PORT:-5179}"

# Stamped into every payload so the daemon can spot an outdated installed
# hook and log a re-run-the-installer warning. Bump on any payload-contract
# change. A payload without the field is a pre-versioning hook (version 0).
HOOK_VERSION=1

# Match the daemon's transport. The launcher writes {"transport":"http"} to
# config.json when the user opts out of HTTPS; absent (or anything else) means
# the default, HTTPS. Cheap grep -- this runs on every hook event, so no python/jq.
SCHEME="https"
CONFIG_FILE="${HOME}/.expediter/config.json"
if [ -f "$CONFIG_FILE" ] && grep -q '"transport"[[:space:]]*:[[:space:]]*"http"' "$CONFIG_FILE" 2>/dev/null; then
	SCHEME="http"
fi

# Mode selection. An ssh session is the stronger topology signal — a local
# Mac session never has $SSH_CONNECTION — so it is checked first (the old
# TMUX_PANE-first order made tmux-on-the-remote-box masquerade as local,
# shipping a far-side pane id the daemon treated as one of its own). ssh with
# a pane → remote-tmux (tmux runs on the ssh-ed box itself); ssh without →
# plain remote; a pane without ssh → local. Neither → the agent launched
# outside every topology; a ticket would be unfocusable — bail silently.
if [ -n "${SSH_CONNECTION:-}" ]; then
	if [ -n "${TMUX_PANE:-}" ]; then
		MODE="remote-tmux"
	else
		MODE="remote"
	fi
elif [ -n "${TMUX_PANE:-}" ]; then
	MODE="local"
else
	exit 0
fi

# remote-tmux only: this process's $SSH_CONNECTION was frozen when the pane
# was created — after detach → disconnect → re-ssh → re-attach it names a
# dead connection the Mac cannot correlate. The tmux *session* environment is
# refreshed on every attach (SSH_CONNECTION is in tmux's default
# update-environment list), so prefer it. Only a "SSH_CONNECTION=..." line
# counts: a "-SSH_CONNECTION" removal marker, a missing variable, or a tmux
# failure leave FRESH_SSH empty and the process-env copy is used instead.
FRESH_SSH=""
if [ "$MODE" = "remote-tmux" ]; then
	TMUX_ENV_LINE=$(tmux show-environment SSH_CONNECTION 2>/dev/null) || TMUX_ENV_LINE=""
	case "$TMUX_ENV_LINE" in
		SSH_CONNECTION=*) FRESH_SSH="${TMUX_ENV_LINE#SSH_CONNECTION=}" ;;
	esac
fi

# Re-emit the agent's JSON payload with the mode's identity fields added and
# (defensively) hook_event_name set from $1. Uses python3 -c (not
# python3 - <<HEREDOC, which would attach the heredoc as python's stdin and
# steal the agent's JSON) so the original piped stdin reaches
# sys.stdin.read(). In both remote modes the same python process also ships
# this box's chat title — the Mac cannot read far-side sources — branched by
# the transcript_path segment: /.codex/ reads threads.title from the box's
# own state db (${CODEX_SQLITE_HOME:-${CODEX_HOME:-~/.codex}}/state_5.sqlite,
# read-only, stdlib sqlite3 — the env chain resolves correctly because the
# hook inherits the codex process's environment); anything else keeps the
# Claude backward scan for the latest custom-title line, mirroring the
# daemon's latestCustomTitle (src/lib/transcript.ts). The field is omitted
# when no title exists yet (absent row/db, or a brand-new session).
# remote-tmux additionally ships remote_pane ($TMUX_PANE here is a far-side
# pane id — it must never ride in tmux_pane, which the daemon treats as a
# local pane) and prefers the fresh session-env ssh_connection read above.
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
if mode == "remote" or mode == "remote-tmux":
    data["remote"] = True
    if mode == "remote-tmux":
        fresh = sys.argv[4] if len(sys.argv) > 4 else ""
        data["ssh_connection"] = fresh or os.environ.get("SSH_CONNECTION", "")
        data["remote_pane"] = os.environ.get("TMUX_PANE", "")
    else:
        data["ssh_connection"] = os.environ.get("SSH_CONNECTION", "")
    tp = data.get("transcript_path")
    if isinstance(tp, str) and "/.codex/" in tp:
        sid = data.get("session_id")
        if isinstance(sid, str) and sid:
            try:
                import sqlite3
                home = (
                    os.environ.get("CODEX_SQLITE_HOME")
                    or os.environ.get("CODEX_HOME")
                    or os.path.expanduser("~/.codex")
                )
                db = os.path.join(home, "state_5.sqlite")
                con = sqlite3.connect("file:" + db + "?mode=ro", uri=True)
                try:
                    row = con.execute(
                        "SELECT title FROM threads WHERE id = ?", (sid,)
                    ).fetchone()
                finally:
                    con.close()
                if row and isinstance(row[0], str) and row[0].strip():
                    data["title"] = row[0].strip()
            except Exception:
                pass
    elif isinstance(tp, str) and tp:
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
try:
    data["hook_version"] = int(sys.argv[3])
except Exception:
    data["hook_version"] = 0
sys.stdout.write(json.dumps(data))
' "$EVENT" "$MODE" "$HOOK_VERSION" "$FRESH_SSH" 2>/dev/null) || PAYLOAD=""

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
	# D17: on a devbox the tunnel's near end is a user-private unix socket
	# (kernel-enforced 0600 — file permission is the auth, and no shared-box
	# port to squat). install-remote.sh wrote its path to
	# ~/.expediter/socket-path; when that socket is live, POST through it.
	# Missing file or dead socket → the legacy TCP tunnel on localhost:5179,
	# so pre-socket installs keep working unchanged. The ${arr[@]+...} form
	# survives `set -u` with an empty array on old bash.
	SOCKET_ARGS=()
	SOCKET_FILE="${HOME}/.expediter/socket-path"
	if [ -f "$SOCKET_FILE" ]; then
		SOCKET_PATH=$(head -n 1 "$SOCKET_FILE" 2>/dev/null)
		if [ -n "$SOCKET_PATH" ] && [ -S "$SOCKET_PATH" ]; then
			SOCKET_ARGS=(--unix-socket "$SOCKET_PATH")
		fi
	fi
	STATUS=$(curl -s -o /dev/null -m 2 -w '%{http_code}' $INSECURE \
		${SOCKET_ARGS[@]+"${SOCKET_ARGS[@]}"} \
		-X POST "${SCHEME}://localhost:${PORT}/api/hooks/event" \
		-H 'Content-Type: application/json' \
		-d "$PAYLOAD" 2>/dev/null)
	if [ -n "${DEBUG_HOOK:-}" ] && [[ "$STATUS" != 2* ]]; then
		echo "[hook] daemon returned HTTP $STATUS for /api/hooks/event" >&2
	fi
fi

exit 0
