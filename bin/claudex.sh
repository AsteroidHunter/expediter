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
			sonnet)
				# Sonnet explainer prompt — locked verbatim from the
				# claudex-uno plan's _strings.md (iterated to v5 with the
				# user). Quoted heredoc <<'END_PROMPT' so backticks around
				# `expediter` / `claudex` aren't run as command substitutions.
				# Using `read -r -d ''` instead of `PROMPT=$(cat <<...)`
				# because bash 3.2 (macOS default) misparses apostrophes
				# inside heredocs when the heredoc is wrapped in $(),
				# treating them as opening single-quotes for shell parsing.
				# `read -r -d ''` reads the heredoc into PROMPT without
				# wrapping it in command substitution. `|| true` because
				# read returns non-zero on EOF (expected with -d '').
				IFS= read -r -d '' PROMPT <<'END_PROMPT' || true
You're greeting a new user who just ran `claudex uno` for the first time. They're new to both the expediter and tmux. Output plain terminal text with three numbered sections.

Format:

1. What is the expediter?

A few short sentences, warm and conversational. The real value: it reduces the friction of getting to any agent session. When an agent needs you — a permission request, or an update — your phone alerts you, and tapping the ticket jumps you straight to that session in your Terminal. Keeps you actively in the loop with all your running agents at once, without hunting through tabs for which one needs you. Phone and Mac need to be on the same network. Do NOT frame it as "avoid walking back to your desk" or "watch agents from your phone" — frame it as "actively stay in the loop, get to the right session fast".

2. What is tmux?

Really ELI5 — explain it like to a curious 5-year-old. tmux is a tab manager for your terminal. Use a friendly analogy in one or two sentences. Then present two lists.

First list — sessions/windows/panes. Each line is "Term: explanation". Format like:

Sessions: separate workspaces, like different projects.
Windows: tabs within a session.
Panes: splits inside a window, for seeing things side-by-side.

Second list — handy hotkeys. Each line is "command: what it does". Format like:

Ctrl-b c: opens a new window.
Ctrl-b n: jumps to the next window.
Ctrl-b d: detaches from the session (keeps running in the background).
Ctrl-b &: closes the current window.

3. How to use the expediter

For any future session, as long as you run `expediter` and are interacting with Claude Code inside tmux, you'll be able to monitor those agents from your phone. You can also just type `claudex` to open both the expediter and Claude Code at once inside tmux.

After section 3, a short closing line: If you have any questions, I recommend asking Claude first — Claude knows a lot. Or feel free to message the developer at hi@givemeanudge.com or @akashbert on X.

No markdown formatting (no bold, italics, bullets, or hash headers). Just plain text with numbered section titles and the line-by-line list format shown above. Conversational tone. Keep each section brief.
END_PROMPT
				;;
			haiku)
				PROMPT="Write a haiku about a positive, collaborative human-AI future."
				;;
			"")
				echo "claudex tour: missing model. Usage: claudex tour [sonnet|haiku]" >&2
				exit 1
				;;
			*)
				echo "claudex tour: unknown model '$MODEL'. Usage: claudex tour [sonnet|haiku]" >&2
				exit 1
				;;
		esac
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
