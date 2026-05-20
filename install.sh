#!/usr/bin/env bash
# install.sh — set up Expediter for daily use on macOS.
#
# Run from the cloned repo:
#   ./install.sh
#
# What it does, in order:
#   1. Verifies macOS (Expediter assumes macOS + USB-tethered phone).
#   2. Checks for Claude Code; offers to install it via the official installer.
#   3. Checks for tmux / Homebrew / Bun and offers to install whatever is
#      missing via a single confirmation.
#   4. Runs `bun install` + `bun run build` to produce build/index.js.
#   5. Writes ~/.config/expediter/config with EXPEDITER_HOME=<clone path>.
#   6. Installs `expediter` and `claudex` shims into ~/.local/bin and ensures
#      that directory is on PATH (added to ~/.zshrc if missing).
#   7. Offers to merge Expediter's hook entries into ~/.claude/settings.json,
#      with a timestamped backup.
#   8. Offers to source expediter.tmux.conf from ~/.tmux.conf, with backup.

set -euo pipefail

LOG="$HOME/.expediter-install.log"
: > "$LOG"
REPO="$(cd "$(dirname "$0")" && pwd)"

# --- helpers ---------------------------------------------------------------

err() { printf '%s\n' "$*" >&2; }

run_quiet() {
	if ! "$@" >>"$LOG" 2>&1; then
		err "Step failed: $*"
		err "See $LOG for details."
		exit 1
	fi
}

# --- presentation helpers --------------------------------------------------
# ANSI color only when stdout is a TTY (keeps logs/redirects clean).

if [ -t 1 ]; then
	BOLD=$'\033[1m'
	DIM=$'\033[2m'
	GREEN=$'\033[38;2;0;114;0m'
	RESET=$'\033[0m'
else
	BOLD='' DIM='' GREEN='' RESET=''
fi

# Per-phase spinner frame sets. See the wiki plan's _openqs-tradeoffs and
# _strings files for the per-phase mapping rationale.
SPIN_HEAVY=(⣾ ⣽ ⣻ ⢿ ⡿ ⣟ ⣯ ⣷)
SPIN_CIRCLE=(◐ ◓ ◑ ◒)
SPIN_CLASSIC=('|' '/' '-' '\')

# Active spinner frame set. Reassigned at the start of each phase that uses
# the spinner, e.g. SPIN_FRAMES=("${SPIN_HEAVY[@]}").
SPIN_FRAMES=("${SPIN_HEAVY[@]}")

# banner <subtitle> — print the gradient EXPEDITER ASCII followed by a
# right-aligned subtitle. Gradient is computed in inline python3 because
# UTF-8-aware per-char iteration in bash is awkward (each █/╔ is 3 bytes).
# Brand-green #007200 on the left fades to (180, 240, 180) on the right.
banner() {
	local subtitle="${1:-}"
	local use_color=0
	[ -t 1 ] && use_color=1
	python3 - "$subtitle" "$use_color" <<'PY'
import sys
subtitle = sys.argv[1] if len(sys.argv) > 1 else ""
use_color = (sys.argv[2] == "1") if len(sys.argv) > 2 else False
ROWS = [
    "███████╗██╗  ██╗██████╗ ███████╗██████╗ ██╗████████╗███████╗██████╗",
    "██╔════╝╚██╗██╔╝██╔══██╗██╔════╝██╔══██╗██║╚══██╔══╝██╔════╝██╔══██╗",
    "█████╗   ╚███╔╝ ██████╔╝█████╗  ██║  ██║██║   ██║   █████╗  ██████╔╝",
    "██╔══╝   ██╔██╗ ██╔═══╝ ██╔══╝  ██║  ██║██║   ██║   ██╔══╝  ██╔══██╗",
    "███████╗██╔╝ ██╗██║     ███████╗██████╔╝██║   ██║   ███████╗██║  ██║",
    "╚══════╝╚═╝  ╚═╝╚═╝     ╚══════╝╚═════╝╚═╝   ╚═╝   ╚═══════╝╚═╝  ╚═╝",
]
START = (0, 114, 0)
END = (180, 240, 180)
width = max(len(r) for r in ROWS)
for row in ROWS:
    out = []
    for i, ch in enumerate(row):
        if ch == " " or not use_color:
            out.append(ch)
            continue
        t = i / max(width - 1, 1)
        r = int(START[0] + t * (END[0] - START[0]))
        g = int(START[1] + t * (END[1] - START[1]))
        b = int(START[2] + t * (END[2] - START[2]))
        out.append(f"\x1b[38;2;{r};{g};{b}m{ch}")
    if use_color:
        out.append("\x1b[0m")
    print("".join(out))
if subtitle:
    pad = max(width - len(subtitle), 0)
    print(" " * pad + subtitle)
PY
}

# section <title> — print a bold numbered header followed by a `─` underline
# matching the title's character length, then a blank line.
section() {
	local title="$1"
	printf '\n%s%s%s\n' "$BOLD" "$title" "$RESET"
	local len=${#title} i=0 underline=""
	while [ "$i" -lt "$len" ]; do
		underline="${underline}─"
		i=$((i+1))
	done
	printf '%s\n\n' "$underline"
}

# spinner <running-msg> <success-msg> <command...> — animates the active frame
# set on the current line while <command> runs in the background, then
# overwrites the line with `✓ <success-msg>`. On non-zero exit, prints
# `⚠ <running-msg> failed. See <log> for details.` and exits 1.
# Honors TTY-vs-not: no animation when stdout is redirected, but command
# still runs and the ✓/⚠ outcome is still printed.
spinner() {
	local running="$1"
	local success="$2"
	shift 2
	local code=0
	if [ -t 1 ]; then
		"$@" >>"$LOG" 2>&1 &
		local pid=$!
		local i=0 n=${#SPIN_FRAMES[@]}
		while kill -0 "$pid" 2>/dev/null; do
			printf '\r%s%s%s %s' "$GREEN" "${SPIN_FRAMES[i % n]}" "$RESET" "$running"
			i=$((i+1))
			sleep 0.08
		done
		wait "$pid" || code=$?
		printf '\r\033[K'
	else
		"$@" >>"$LOG" 2>&1 || code=$?
	fi
	if [ "$code" -eq 0 ]; then
		printf '%s✓%s %s\n' "$GREEN" "$RESET" "$success"
	else
		printf '⚠ %s failed. See %s for details.\n' "$running" "$LOG" >&2
		exit 1
	fi
}

# dev_note — print the developer's note: ☼ glyph + bold "Note from developer:"
# header + body paragraph. Body is locked verbatim against the wiki plan's
# _strings file.
dev_note() {
	printf '%s☼%s %sNote from developer:%s\n\n' "$RESET" "$RESET" "$BOLD" "$RESET"
	printf 'Hi, thanks for trying the expediter!\n\n'
	printf 'I have been using it while developing the expediter (so meta, I know)\n'
	printf 'and I feel it has helped me better stay on top of all my active claude\n'
	printf 'code sessions. I am eager to hear what you make of it. Questions and\n'
	printf 'feedback are welcome! You can reach me here: hi@givemeanudge.com or\n'
	printf '@akashbert on X\n\n'
}

# prompt_keypress <valid-chars> <prompt-text>
# Reads single chars (no Enter required) until one matches a char in
# <valid-chars>. Echoes only matched chars; ignores invalid keypresses
# (including Enter). Stores the matched character in REPLY.
prompt_keypress() {
	local valid="$1"
	local prompt="$2"
	printf '%s' "$prompt"
	local ch
	while true; do
		read -s -n 1 -r ch || true
		if [ -n "$ch" ] && [[ "$valid" == *"$ch"* ]]; then
			printf '%s\n' "$ch"
			REPLY="$ch"
			return 0
		fi
	done
}

# --- 0. preflight ----------------------------------------------------------

if [ "$(uname -s)" != "Darwin" ]; then
	err "The expediter runs on macOS only. Linux and Windows support are not yet available. Sorry!"
	exit 1
fi

banner "installer"
printf '\n'
dev_note
prompt_keypress "yn" "Ready to begin installation? (y / n) "
if [ "$REPLY" != "y" ]; then
	printf 'Leaving so soon? Bon voyage 🚢\n'
	exit 0
fi

# --- 1. Claude Code check --------------------------------------------------

SPIN_FRAMES=("${SPIN_HEAVY[@]}")
section "1. Claude Code check"
printf 'The expediter currently only works with claude code.\n\n'

# The `command -v` check is instant; the spinner helper expects a long-running
# backgrounded command. Show a brief static spinner frame instead for visual
# consistency with the longer-running phases below, then resolve.
if [ -t 1 ]; then
	printf '%s%s%s Checking if you have claude code installed ...' "$GREEN" "${SPIN_FRAMES[0]}" "$RESET"
	sleep 0.2
	printf '\r\033[K'
fi

if command -v claude >/dev/null 2>&1; then
	printf '%s✓%s Claude code detected!\n' "$GREEN" "$RESET"
else
	printf 'Seems like you don'\''t have claude code installed.\n\n'
	prompt_keypress "yn" "Would you like to install it? (y / n) "
	if [ "$REPLY" = "y" ]; then
		printf '\nHanding off to the official claude code installer ...\n\n'
		# Inherited stdio: Claude Code's TUI takes over the terminal. The
		# binary opens /dev/tty for input, so the curl|bash pipeline's
		# exhausted stdin does not block keyboard input. See the
		# stdout-redaction decision in the wiki plan for the mechanical detail.
		bash -c 'curl -fsSL https://claude.ai/install.sh | bash'
		# Native installer drops the binary at ~/.local/bin/claude.
		export PATH="$HOME/.local/bin:$PATH"
		if ! command -v claude >/dev/null 2>&1; then
			err ""
			err "⚠ Claude code install completed but \`claude\` is still not on PATH."
			err "  Open a new terminal and re-run this script."
			exit 1
		fi
		printf '%s✓%s Claude code installed!\n' "$GREEN" "$RESET"
	else
		printf '\nIf you wish to use the expediter, please install claude code. You can do so manually here:\n'
		printf '  https://docs.claude.com/en/docs/claude-code/setup\n'
		exit 1
	fi
fi

# --- 2. Tmux check ---------------------------------------------------------

SPIN_FRAMES=("${SPIN_CIRCLE[@]}")
section "2. Tmux check"
printf 'The expediter uses tmux to keep track of claude code sessions.\n\n'

if [ -t 1 ]; then
	printf '%s%s%s Checking if you have tmux installed ...' "$GREEN" "${SPIN_FRAMES[0]}" "$RESET"
	sleep 0.2
	printf '\r\033[K'
fi

if command -v tmux >/dev/null 2>&1; then
	printf '%s✓%s tmux detected!\n' "$GREEN" "$RESET"
else
	printf 'Uh oh, no tmux on this machine.\n\n'
	prompt_keypress "yn" "Would you like to install tmux via brew? (y / n) "
	if [ "$REPLY" = "y" ]; then
		printf '\n'
		if command -v brew >/dev/null 2>&1; then
			printf '%s✓%s Brew detected! Marching on ...\n\n' "$GREEN" "$RESET"
			spinner "Installing tmux ..." "tmux installed." brew install tmux
		else
			# Foreground brew install — sudo prompts go to /dev/tty and would
			# compete with a spinner animation. Print a single static spinner
			# frame, run the install in foreground (run_quiet captures
			# stdout/stderr; sudo still surfaces via /dev/tty), then print the
			# transition line, then animate the tmux install (no sudo needed).
			printf '%s%s%s Installing brew first ...\n' "$GREEN" "${SPIN_FRAMES[0]}" "$RESET"
			run_quiet bash -c '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'
			if [ -x /opt/homebrew/bin/brew ]; then
				eval "$(/opt/homebrew/bin/brew shellenv)"
			elif [ -x /usr/local/bin/brew ]; then
				eval "$(/usr/local/bin/brew shellenv)"
			fi
			printf '%s✓%s Now tmux ...\n\n' "$GREEN" "$RESET"
			spinner "Installing tmux ..." "tmux installed!" brew install tmux
		fi
	else
		printf '\nIf you wish to use the expediter, please install tmux. You can grab homebrew at https://brew.sh and then run `brew install tmux`.\n'
		exit 1
	fi
fi

# --- 3. Build --------------------------------------------------------------

SPIN_FRAMES=("${SPIN_HEAVY[@]}")
section "3. Build"
printf 'Installing dependencies and building the app.\n\n'

# Silent: install Bun if missing. The user already consented at the Ready
# prompt; Bun is a build-time prerequisite they don't need to think about.
if ! command -v bun >/dev/null 2>&1; then
	run_quiet bash -c 'curl -fsSL https://bun.sh/install | bash'
	export BUN_INSTALL="$HOME/.bun"
	export PATH="$BUN_INSTALL/bin:$PATH"
fi

# Visible: spinner-wrapped bun install + bun run build. The spinner helper
# aborts with `⚠ <running> failed. See <log> for details.` on non-zero exit.
spinner "Installing dependencies ..." "Dependencies installed." bash -c "cd '$REPO' && bun install"
spinner "Building ..." "App built." bash -c "cd '$REPO' && bun run build"

# Silent: write the config file. Quoted heredoc <<'EOF' so the backticks
# around `export` in the comment text aren't run as command substitutions.
# $REPO needs interpolation, so it's appended via printf after the heredoc.
mkdir -p "$HOME/.config/expediter"
cat > "$HOME/.config/expediter/config" <<'EOF'
# expediter config — written by install.sh
# If you move the cloned repo, update EXPEDITER_HOME below (or re-run install.sh).
# The `export` is load-bearing: the shims source this file and exec bun, which
# is a child process — without `export`, EXPEDITER_HOME would be a shell var and
# would not propagate to bun's environment, causing bin/expediter.mjs to abort.
EOF
printf 'export EXPEDITER_HOME="%s"\n' "$REPO" >> "$HOME/.config/expediter/config"

# Silent: write the two shims.
mkdir -p "$HOME/.local/bin"
cat > "$HOME/.local/bin/expediter" <<'EOF'
#!/usr/bin/env bash
# expediter shim — installed by install.sh. Reads ~/.config/expediter/config
# to find the cloned repo, then runs bin/expediter.mjs under Bun.
config="$HOME/.config/expediter/config"
if [ ! -f "$config" ]; then
	echo "expediter: missing $config. Re-run install.sh from the cloned repo." >&2
	exit 1
fi
# shellcheck disable=SC1090
. "$config"
# Re-export defensively in case the user edited the config and dropped `export`.
# The mjs reads process.env.EXPEDITER_HOME and bails if it's not in env.
export EXPEDITER_HOME
if [ -z "${EXPEDITER_HOME:-}" ] || [ ! -d "$EXPEDITER_HOME" ]; then
	echo "expediter: cannot find the Expediter repo at ${EXPEDITER_HOME:-<unset>}"
	echo "The folder may have been moved or renamed."
	echo "Edit $config and update EXPEDITER_HOME to the new location."
	exit 1
fi
exec bun "$EXPEDITER_HOME/bin/expediter.mjs" "$@"
EOF
chmod +x "$HOME/.local/bin/expediter"

cat > "$HOME/.local/bin/claudex" <<'EOF'
#!/usr/bin/env bash
# claudex shim — installed by install.sh.
config="$HOME/.config/expediter/config"
if [ ! -f "$config" ]; then
	echo "claudex: missing $config. Re-run install.sh from the cloned repo." >&2
	exit 1
fi
# shellcheck disable=SC1090
. "$config"
# Re-export defensively — claudex.sh and any child process needs it in env.
export EXPEDITER_HOME
if [ -z "${EXPEDITER_HOME:-}" ] || [ ! -d "$EXPEDITER_HOME" ]; then
	echo "claudex: cannot find the Expediter repo at ${EXPEDITER_HOME:-<unset>}"
	echo "The folder may have been moved or renamed."
	echo "Edit $config and update EXPEDITER_HOME to the new location."
	exit 1
fi
exec "$EXPEDITER_HOME/bin/claudex.sh" "$@"
EOF
chmod +x "$HOME/.local/bin/claudex"

# Status-bar helpers — small bash scripts referenced by expediter.tmux.conf for
# `status-right` (cc-clock) and the `pane-border-format` (cc-dates). Copied
# straight from the repo so users can edit them later without re-running
# install.sh. cc-dates silently no-ops if `jq` isn't installed.
for helper in cc-clock cc-dates; do
	cp "$REPO/bin/$helper" "$HOME/.local/bin/$helper"
	chmod +x "$HOME/.local/bin/$helper"
done

# Silent: PATH check. Only surface a line at the end of this phase if we
# actually appended to the user's shell rc (rare; Claude Code's installer
# typically already puts ~/.local/bin on PATH).
PATH_APPENDED=0
PATH_RC=""
case ":$PATH:" in
	*":$HOME/.local/bin:"*) ;;
	*)
		# zsh is the macOS default; fall back to ~/.bashrc only if no zshrc exists.
		PATH_RC="$HOME/.zshrc"
		if [ ! -f "$PATH_RC" ] && [ -f "$HOME/.bashrc" ]; then
			PATH_RC="$HOME/.bashrc"
		fi
		printf '\n# Added by Expediter installer\nexport PATH="$HOME/.local/bin:$PATH"\n' >> "$PATH_RC"
		PATH_APPENDED=1
		;;
esac

# Silent: merge hooks into ~/.claude/settings.json. Auto-merged without a
# y/n prompt — see the silent-hooks decision in the wiki plan. Timestamped
# backup taken first if settings.json already exists. python3's merge output
# is captured into the install log; non-zero exit surfaces a friendly error.
mkdir -p "$HOME/.claude"
SETTINGS="$HOME/.claude/settings.json"
HOOK_SCRIPT="$REPO/bin/expediter-hook.sh"
if [ -f "$SETTINGS" ]; then
	BACKUP="$SETTINGS.expediter-bak.$(date +%Y%m%d-%H%M%S)"
	cp "$SETTINGS" "$BACKUP"
fi
if ! python3 - "$SETTINGS" "$HOOK_SCRIPT" >>"$LOG" 2>&1 <<'PY'
import json, os, sys

settings_path, hook_script = sys.argv[1], sys.argv[2]

EVENTS = [
    "Stop",
    "PermissionRequest",
    "Notification",
    "UserPromptSubmit",
    "PostToolUse",
    "PostToolUseFailure",
    "SessionEnd",
]

if os.path.exists(settings_path):
    with open(settings_path) as f:
        try:
            data = json.load(f)
        except json.JSONDecodeError as e:
            sys.stderr.write(f"settings.json is not valid JSON: {e}\n")
            sys.stderr.write("Refusing to overwrite. Fix it manually and re-run install.sh.\n")
            sys.exit(1)
else:
    data = {}

if not isinstance(data, dict):
    sys.stderr.write("settings.json top-level must be an object. Refusing to overwrite.\n")
    sys.exit(1)

hooks = data.setdefault("hooks", {})
if not isinstance(hooks, dict):
    sys.stderr.write("settings.json 'hooks' must be an object. Refusing to overwrite.\n")
    sys.exit(1)

added = 0
skipped = 0
for ev in EVENTS:
    blocks = hooks.setdefault(ev, [])
    if not isinstance(blocks, list):
        sys.stderr.write(f"settings.json hooks.{ev} must be a list. Skipping.\n")
        continue
    already = False
    for block in blocks:
        for h in (block or {}).get("hooks", []) or []:
            if isinstance(h, dict) and hook_script in str(h.get("command", "")):
                already = True
                break
        if already:
            break
    if already:
        skipped += 1
        continue
    blocks.append({
        "matcher": "",
        "hooks": [
            {"type": "command", "command": f"{hook_script} {ev}"}
        ],
    })
    added += 1

with open(settings_path, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")

print(f"Hooks merged: {added} added, {skipped} already present.")
PY
then
	err ""
	err "⚠ Failed to merge hooks into ~/.claude/settings.json. See $LOG for details."
	exit 1
fi

# Conditional surfacing: only emits a line if PATH was actually appended.
if [ "$PATH_APPENDED" = 1 ]; then
	printf '\n  Note: ~/.local/bin was added to your PATH. Open a new terminal or run `source %s` before using `expediter` or `claudex`.\n' "$PATH_RC"
fi

# --- 4. Tmux setup ---------------------------------------------------------

# polish_tmux — apply the expediter tmux styling. Sourced from ~/.tmux.conf
# (or created if no .tmux.conf exists). Idempotent: if .tmux.conf already
# sources us, no change. Backs up before modifying.
polish_tmux() {
	local conf="$HOME/.tmux.conf"
	local source_line="source-file \"$REPO/expediter.tmux.conf\""
	if [ -f "$conf" ]; then
		if grep -Fq "$REPO/expediter.tmux.conf" "$conf"; then
			return 0  # already sources us, idempotent no-op
		fi
		local backup="$conf.expediter-bak.$(date +%Y%m%d-%H%M%S)"
		cp "$conf" "$backup"
		printf '\n# Added by Expediter installer\n%s\n' "$source_line" >> "$conf"
	else
		printf '# Created by Expediter installer\n%s\n' "$source_line" > "$conf"
	fi
}

SPIN_FRAMES=("${SPIN_CLASSIC[@]}")
section "4. Tmux setup"
printf 'Do you already have a preferred tmux set up?\n\n'
printf '  y - yes / don'\''t mess with my tmux\n'
printf '  u - no, give me an upgrade\n'
printf '  w - what is a tmux?\n\n'

prompt_keypress "yuw" "answer: "

case "$REPLY" in
	y)
		printf '\n%s⊘%s Skipped.\n' "$DIM" "$RESET"
		;;
	w)
		printf '\ntmux is an open-source terminal session manager. Think of it as the software that allows the terminal to have richer visual layouts like tabs and panes. It has been the de-facto terminal add-on since the 2010s.\n\n'
		spinner "Polishing tmux ..." "tmux polished!" polish_tmux
		;;
	u)
		printf '\n'
		spinner "Polishing tmux ..." "tmux polished!" polish_tmux
		;;
esac

# --- done ------------------------------------------------------------------

printf '\n%s✦%s Expediter is ready!\n\n' "$GREEN" "$RESET"
printf 'Few ways to use expediter:\n\n'
printf 'expediter   start the daemon and print the QR for linking your phone\n'
printf 'claudex     open tmux with claude + expediter side-by-side\n'
