#!/usr/bin/env bash
# test-focus.sh — diagnostic harness for the tap-to-focus path.
# Runs the same steps as src/lib/tmux.ts:focusPane(), but on the CLI with
# verbose output at each stage. Use it to figure out which step misbehaves
# when tapping a ticket on the phone produces the wrong window/tab.
#
# Usage: bin/test-focus.sh %14

set -u

PANE="${1:-}"
if [ -z "$PANE" ]; then
	echo "usage: $0 <pane-id>   (e.g. %14)" >&2
	exit 64
fi

if ! [[ "$PANE" =~ ^%[0-9]+$ ]]; then
	echo "step 0: pane id '$PANE' does not match ^%[0-9]+$" >&2
	exit 65
fi

echo "=== step 0: pane id ==="
echo "  pane = $PANE"

echo "=== step 1: tmux display-message (resolve pane → session:window_id) ==="
if ! TARGET=$(tmux display-message -p -t "$PANE" '#{session_name}:#{window_id}' 2>&1); then
	echo "  FAILED: $TARGET" >&2
	exit 1
fi
TARGET="${TARGET//$'\n'/}"
echo "  target = '$TARGET'"
SESSION="${TARGET%%:*}"
echo "  session = '$SESSION'"

echo "=== step 2: tmux select-window (switch tmux to that window) ==="
if SW_OUT=$(tmux select-window -t "$TARGET" 2>&1); then
	echo "  OK (output: '${SW_OUT}')"
else
	echo "  FAILED: $SW_OUT" >&2
	exit 2
fi

echo "=== step 3: tmux list-clients (TTYs attached to that session) ==="
LC_OUT=$(tmux list-clients -t "$SESSION" -F '#{client_tty}' 2>&1 || true)
echo "  raw output:"
echo "$LC_OUT" | sed 's/^/    /'
TTY=$(echo "$LC_OUT" | awk 'NF{print; exit}')
echo "  picked tty = '${TTY:-<none>}'"

echo "=== step 4: enumerate Terminal.app windows + tabs ==="
osascript <<'EOF' 2>&1 | sed 's/^/    /'
tell application "Terminal"
	set out to ""
	repeat with w in windows
		try
			repeat with t in tabs of w
				try
					set out to out & "window " & (index of w) & " / tty=" & (tty of t) & " / selected=" & (selected of t) & linefeed
				end try
			end repeat
		end try
	end repeat
	return out
end tell
EOF

echo "=== step 5: AppleScript to be executed ==="
if [ -z "$TTY" ]; then
	SCRIPT='tell application "Terminal" to activate'
else
	ESC_TTY="${TTY//\"/\\\"}"
	SCRIPT=$(cat <<EOS
tell application "Terminal"
	activate
	set targetTTY to "${ESC_TTY}"
	repeat with w in windows
		try
			repeat with t in tabs of w
				try
					if tty of t is targetTTY then
						set selected of t to true
						return "matched=true"
					end if
				end try
			end repeat
		end try
	end repeat
	return "matched=false"
end tell
EOS
)
fi
echo "--- begin script ---"
echo "$SCRIPT"
echo "--- end script ---"

echo "=== step 6: run osascript ==="
OS_OUT=$(osascript -e "$SCRIPT" 2>&1)
OS_RC=$?
echo "  rc=$OS_RC"
echo "  output:"
echo "$OS_OUT" | sed 's/^/    /'

echo "=== step 7: re-enumerate Terminal.app to see final state ==="
osascript <<'EOF' 2>&1 | sed 's/^/    /'
tell application "Terminal"
	set out to ""
	repeat with w in windows
		try
			repeat with t in tabs of w
				try
					if (selected of t) then
						set out to out & "FRONT: window " & (index of w) & " / tty=" & (tty of t) & linefeed
					end if
				end try
			end repeat
		end try
	end repeat
	return out
end tell
EOF
