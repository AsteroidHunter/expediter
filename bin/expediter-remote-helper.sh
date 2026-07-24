#!/usr/bin/env bash
# expediter-remote-helper.sh — devbox side of tap-to-focus for remote-tmux
# tickets (outer-tmux-remote-session D16).
#
# The Mac daemon can never ssh into this box (the user authenticates with
# password+2FA; no keys exist), so taps travel the OTHER way: this helper
# long-polls the daemon through the reverse tunnel — whose near end is a
# user-private unix socket (D17) — and when a tap arrives it flips this box's
# tmux to the tapped window/pane locally and reports the outcome back. The
# daemon matches taps to helpers by ssh host key: every poll carries this
# box's public host keys, and the daemon answers only the helper whose box
# the tapped ticket lives on.
#
# Modes:
#   login-start   Called from the login-script block install-remote.sh
#                 appends (every ssh login). Silent no-op when a helper is
#                 already running or no tunnel socket exists; unlinks a
#                 stale (non-answering) socket and prints ONE loud line —
#                 that connection's forward already failed to bind, so the
#                 user must reconnect once to restore tickets. Otherwise
#                 daemonizes `run`.
#   run           The poll loop itself (internal; started by login-start).
#
# Lifecycle: the poll rides the tunnel, so a dead carrying connection snaps
# it; after a short retry grace the helper unlinks the socket file (its dying
# act — the file is certainly stale by then) and exits. The next ssh login
# binds a fresh socket and starts a fresh helper. A fatal daemon answer
# (e.g. this box's host keys are unreadable) exits WITHOUT unlinking — the
# tunnel is alive and hook events must keep flowing through it.

set -u

MODE="${1:-login-start}"
SOCKET_FILE="${HOME}/.expediter/socket-path"
LOG_FILE="${HOME}/.expediter/helper.log"

# Match the daemon's transport, exactly like expediter-hook.sh: HTTPS unless
# the Mac-side launcher recorded an http opt-out. The devbox has no
# config.json, so this resolves to https (with -k — the tunnel carries the
# daemon's locally-generated cert).
SCHEME="https"
CONFIG_FILE="${HOME}/.expediter/config.json"
if [ -f "$CONFIG_FILE" ] && grep -q '"transport"[[:space:]]*:[[:space:]]*"http"' "$CONFIG_FILE" 2>/dev/null; then
	SCHEME="http"
fi
INSECURE=""
if [ "$SCHEME" = "https" ]; then INSECURE="-k"; fi
BASE_URL="${SCHEME}://localhost:5179"

log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >>"$LOG_FILE" 2>/dev/null || true; }

read_socket_path() {
	[ -f "$SOCKET_FILE" ] || return 1
	SOCK=$(head -n 1 "$SOCKET_FILE" 2>/dev/null)
	[ -n "$SOCK" ] || return 1
	return 0
}

# One curl through the socket; ANY http status proves the tunnel end is
# alive (the daemon answered), curl code 7/etc proves it is not.
socket_answers() {
	curl -s -o /dev/null -m 3 $INSECURE --unix-socket "$SOCK" \
		-X POST "$BASE_URL/api/remote-tap/result" \
		-H 'Content-Type: application/json' -d '{}' >/dev/null 2>&1
}

# This box's ssh host public keys as a JSON payload — the identity the
# daemon matches taps against. World-readable on stock sshd installs; an
# empty list is fatal upstream (the daemon can never route a tap here) and
# the run loop exits on its 422.
host_keys_payload() {
	python3 - <<'PY'
import glob, json
keys = []
for path in sorted(glob.glob("/etc/ssh/ssh_host_*_key.pub")):
    try:
        with open(path) as f:
            parts = f.read().split()
        if len(parts) >= 2:
            keys.append(parts[0] + " " + parts[1])
    except Exception:
        pass
print(json.dumps({"host_keys": keys}))
PY
}

if [ "$MODE" = "login-start" ]; then
	read_socket_path || exit 0
	RUNDIR=$(dirname "$SOCK")
	PIDFILE="$RUNDIR/expediter-helper.pid"
	if [ -f "$PIDFILE" ]; then
		OLDPID=$(head -n 1 "$PIDFILE" 2>/dev/null)
		if [ -n "$OLDPID" ] && kill -0 "$OLDPID" 2>/dev/null; then
			exit 0 # a helper is already serving this box
		fi
		rm -f "$PIDFILE"
	fi
	[ -S "$SOCK" ] || exit 0 # no tunnel this login; nothing to poll through
	if ! socket_answers; then
		# Stale socket file: THIS connection's forward already failed to bind
		# against it, so clear it and say so once, loudly — the reconnect gets
		# a clean bind. (StreamLocalBindUnlink is deliberately not required of
		# the box's sshd config; this is the user-side half of D17.)
		rm -f "$SOCK"
		echo "expediter: cleared a stale tunnel socket — reconnect (ssh in again) to restore phone tickets." >&2
		exit 0
	fi
	mkdir -p "$(dirname "$LOG_FILE")" 2>/dev/null || true
	nohup setsid "$0" run >>"$LOG_FILE" 2>&1 </dev/null &
	exit 0
fi

[ "$MODE" = "run" ] || { echo "usage: $0 [login-start|run]" >&2; exit 1; }

read_socket_path || exit 0
RUNDIR=$(dirname "$SOCK")
PIDFILE="$RUNDIR/expediter-helper.pid"
echo "$$" >"$PIDFILE" 2>/dev/null || true
trap 'rm -f "$PIDFILE"' EXIT

KEYS_PAYLOAD=$(host_keys_payload 2>/dev/null) || KEYS_PAYLOAD='{"host_keys": []}'
log "helper started (pid $$, socket $SOCK)"

# Consecutive poll-transport failures tolerated before concluding the tunnel
# is gone: 10 × (3s timeout headroom + 2s sleep) ≈ a 30-50s grace window,
# covering a daemon restart without covering a genuinely dead connection.
FAILS=0
MAX_FAILS=10

while :; do
	RAW=$(curl -s -m 40 -w '\n%{http_code}' $INSECURE --unix-socket "$SOCK" \
		-X POST "$BASE_URL/api/remote-tap/poll" \
		-H 'Content-Type: application/json' \
		-d "$KEYS_PAYLOAD" 2>/dev/null)
	CURL_RC=$?
	HTTP_CODE="${RAW##*$'\n'}"
	BODY="${RAW%$'\n'*}"

	if [ $CURL_RC -ne 0 ] || [ -z "$HTTP_CODE" ] || [ "$HTTP_CODE" = "000" ]; then
		FAILS=$((FAILS + 1))
		if [ $FAILS -ge $MAX_FAILS ]; then
			# Dying act (D17): the tunnel is gone, so the socket file is a
			# stale husk that would block the next connection's bind.
			log "poll failed ${FAILS}x — tunnel presumed dead; unlinking socket and exiting"
			rm -f "$SOCK"
			exit 0
		fi
		sleep 2
		continue
	fi
	FAILS=0

	if [ "$HTTP_CODE" = "422" ]; then
		log "daemon rejected our identity (422 — unreadable host keys?); exiting without touching the live socket"
		exit 1
	fi
	[ "$HTTP_CODE" = "200" ] || { sleep 2; continue; }

	# Parse the poll answer; empty tap → immediately poll again.
	TAP=$(printf '%s' "$BODY" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
tap = d.get("tap")
if isinstance(tap, dict) and tap.get("tap_id") and tap.get("remote_pane"):
    print(str(tap["tap_id"]))
    print(str(tap["remote_pane"]))
' 2>/dev/null)
	[ -n "$TAP" ] || continue
	TAP_ID=$(printf '%s\n' "$TAP" | sed -n 1p)
	PANE=$(printf '%s\n' "$TAP" | sed -n 2p)

	OK=false
	ATTACHED=""
	SESSION=""
	ERROR=""
	# D14 re-check at the last hand before exec: only a bare %N reaches tmux.
	if ! printf '%s' "$PANE" | grep -Eq '^%[0-9]+$'; then
		ERROR="refused malformed pane id"
		log "tap $TAP_ID: refused pane '$PANE'"
	elif tmux select-window -t "$PANE" \; select-pane -t "$PANE" 2>/dev/null; then
		OK=true
		STATE=$(tmux display-message -p -t "$PANE" '#{session_attached}|#{session_name}' 2>/dev/null || true)
		ATTACHED="${STATE%%|*}"
		SESSION="${STATE#*|}"
	else
		ERROR="tmux select-window/select-pane failed (pane gone?)"
		log "tap $TAP_ID: $ERROR"
	fi

	RESULT=$(python3 - "$TAP_ID" "$OK" "$ATTACHED" "$SESSION" "$ERROR" <<'PY'
import json, sys
tap_id, ok, attached, session, error = sys.argv[1:6]
out = {"tap_id": tap_id, "ok": ok == "true"}
if attached.isdigit():
    out["session_attached"] = int(attached) > 0
if session:
    out["session_name"] = session
if error:
    out["error"] = error
print(json.dumps(out))
PY
)
	curl -s -o /dev/null -m 5 $INSECURE --unix-socket "$SOCK" \
		-X POST "$BASE_URL/api/remote-tap/result" \
		-H 'Content-Type: application/json' \
		-d "$RESULT" 2>/dev/null || log "tap $TAP_ID: result POST failed"
done
