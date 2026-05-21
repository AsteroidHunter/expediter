#!/usr/bin/env bash
# claudex — open a fresh tmux session with `expediter` and `claude` in two
# side-by-side panes, then attach (or switch) to it.
#
# Run from anywhere via the ~/.local/bin/claudex shim installed by install.sh.
# The shim sets EXPEDITER_HOME but this script doesn't need it — it only needs
# `claude` and `expediter` to be on PATH (which install.sh guarantees).
#
# Subcommands:
#   claudex                 default: expediter (left) + claude (right) panes
#   claudex uno             newbie onboarding (daemon + QR + 4 numbered steps)
#   claudex tour sonnet     fresh tmux session with the Sonnet explainer
#   claudex tour haiku      fresh tmux session with the Haiku haiku-writer

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

# --- subcommand dispatch --------------------------------------------------
# claudex             (no args)  → existing behavior (claude + expediter)
# claudex uno                    → newbie onboarding (daemon + QR + 4 steps)
# claudex tour sonnet            → fresh tmux session with Sonnet explainer
# claudex tour haiku             → fresh tmux session with Haiku haiku-writer
# anything else                  → usage + exit 1

case "${1:-}" in
	"")
		# Fall through to existing claudex behavior below.
		;;
	uno)
		# Hand off to expediter with the four newbie-onboarding steps.
		# expediter --steps splits on `|` and prints each as a numbered line
		# beneath the QR. The user manually opens two new tabs and runs
		# `claudex tour sonnet` / `claudex tour haiku` in each.
		exec expediter --steps "Scan the QR with your phone.|Open a new tab (Cmd+T) and run: claudex tour sonnet|Open another new tab (Cmd+T) and run: claudex tour haiku|After running all these steps, watch your phone!"
		;;
	tour)
		MODEL="${2:-}"
		case "$MODEL" in
			sonnet|haiku) ;;
			"")
				echo "claudex tour: missing model. Usage: claudex tour [sonnet|haiku]" >&2
				exit 1
				;;
			*)
				echo "claudex tour: unknown model '$MODEL'. Usage: claudex tour [sonnet|haiku]" >&2
				exit 1
				;;
		esac
		# Tour prompts live in $EXPEDITER_HOME/bin/uno_prompts/<model>.txt so
		# they can be edited without touching shell-quoting in this script.
		# The shim at ~/.local/bin/claudex sets EXPEDITER_HOME before exec'ing
		# this file.
		if [ -z "${EXPEDITER_HOME:-}" ] || [ ! -d "$EXPEDITER_HOME" ]; then
			echo "claudex tour: EXPEDITER_HOME is not set. Re-run install.sh." >&2
			exit 1
		fi
		PROMPT_TXT="$EXPEDITER_HOME/bin/uno_prompts/$MODEL.txt"
		if [ ! -f "$PROMPT_TXT" ]; then
			echo "claudex tour: prompt file not found at $PROMPT_TXT" >&2
			exit 1
		fi
		PROMPT="Read $PROMPT_TXT and respond per its contents."
		# Shell-escape the prompt for safe consumption by tmux's /bin/sh -c.
		# printf '%q' produces a re-quoted form that survives one more layer
		# of shell parsing (tmux runs the new-session command via /bin/sh -c).
		TOUR_SESSION="claudex-tour-$MODEL-$(date +%s)"
		QUOTED_PROMPT=$(printf '%q' "$PROMPT")
		tmux new-session -d -s "$TOUR_SESSION" -n claude -c "$PWD" "claude --model $MODEL $QUOTED_PROMPT"
		if [ -n "${TMUX:-}" ]; then
			tmux switch-client -t "$TOUR_SESSION"
		else
			tmux attach-session -t "$TOUR_SESSION"
		fi
		exit 0
		;;
	*)
		echo "claudex: unknown subcommand '$1'" >&2
		echo "Usage: claudex [uno | tour sonnet | tour haiku]" >&2
		exit 1
		;;
esac

# --- default behavior (no subcommand) -------------------------------------
# Generate a unique session name. The seconds-since-epoch suffix keeps each
# claudex invocation isolated, so running it twice gives you two independent
# sessions instead of clobbering the first.
SESSION="claudex-$(date +%s)"

# One window split into two side-by-side panes: expediter (QR) on the left,
# claude on the right. Side-by-side panes are friendlier to first-time users
# than two windows behind tmux navigation — both processes are visible from
# the moment they attach, no Ctrl-b n required to find the QR.
# tmux's -h flag splits "horizontally" by tmux convention, which actually
# produces panes that sit side-by-side (the new pane is to the right of the
# original). -v would stack them vertically.
#
# `; exec $SHELL` on the expediter pane keeps it open after expediter exits.
# When the daemon is already up, `expediter` prints the QR and returns
# immediately — without this, the pane would close and the user would see
# only the claude pane.
tmux new-session -d -s "$SESSION" -n main -c "$PWD" "expediter; exec \${SHELL:-bash}"
tmux split-window -t "$SESSION:main" -h -c "$PWD" 'claude'

# After the split, pane 0 is expediter (left) and pane 1 is claude (right).
# Land the user on the claude pane so they can start typing immediately; the
# QR remains visible to their left.
tmux select-pane -t "$SESSION:main.1"

# If we're already inside tmux, switch-client; otherwise attach. Either way
# the user ends up looking at the new session with both panes visible.
if [ -n "${TMUX:-}" ]; then
	tmux switch-client -t "$SESSION"
else
	tmux attach-session -t "$SESSION"
fi
