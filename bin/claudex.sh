#!/usr/bin/env bash
# claudex — open a fresh tmux session with `claude` in one window and
# `expediter` in another, then attach (or switch) to it.
#
# Run from anywhere via the ~/.local/bin/claudex shim installed by install.sh.
# The shim sets EXPEDITER_HOME but this script doesn't need it — it only needs
# `claude` and `expediter` to be on PATH (which install.sh guarantees).

set -u

if ! command -v tmux >/dev/null 2>&1; then
	echo "claudex: tmux is not installed. Re-run install.sh." >&2
	exit 1
fi

if ! command -v claude >/dev/null 2>&1; then
	echo "claudex: claude is not installed. Re-run install.sh." >&2
	exit 1
fi

if ! command -v expediter >/dev/null 2>&1; then
	echo "claudex: expediter is not installed. Re-run install.sh." >&2
	exit 1
fi

# Generate a unique session name. The seconds-since-epoch suffix keeps each
# claudex invocation isolated, so running it twice gives you two independent
# sessions instead of clobbering the first.
SESSION="claudex-$(date +%s)"

# Create the session detached with the claude window first so it's window 1.
tmux new-session -d -s "$SESSION" -n claude -c "$PWD" 'claude'
tmux new-window -t "$SESSION:" -n expediter -c "$PWD" 'expediter'

# Select the claude window so the user lands on it (vs. the expediter logs).
tmux select-window -t "$SESSION:claude"

# If we're already inside tmux, switch-client; otherwise attach. Either way
# the user ends up looking at the new session's claude window.
if [ -n "${TMUX:-}" ]; then
	tmux switch-client -t "$SESSION"
else
	tmux attach-session -t "$SESSION"
fi
