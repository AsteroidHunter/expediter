#!/usr/bin/env bash
# uninstall.sh — undo what install.sh did on macOS.
#
# Run from anywhere (does not need to be the cloned repo):
#   ./uninstall.sh
#
# What it does, in order:
#   1. Verifies macOS.
#   2. Detects whether something is listening on port 5179 and aborts if so —
#      tearing down shims while the daemon is running would leave an orphaned
#      bun process.
#   3. Asks for a single top-level confirmation.
#   4. Removes ~/.local/bin/expediter and ~/.local/bin/claudex.
#   5. Removes ~/.config/expediter/config (and the parent dir, if it ends up
#      empty).
#   6. Splices Expediter hook matcher blocks out of ~/.claude/settings.json,
#      preserving anything else in the file. Saves a fresh timestamped backup
#      before touching it.
#   7. Splices the source-file line for expediter.tmux.conf out of
#      ~/.tmux.conf, plus the "# Added/Created by Expediter installer" comment
#      that install.sh wrote above it. Deletes the file if nothing else is in
#      it. Backs up before touching.
#   8. Removes ~/.expediter-install.log.
#
# What it does NOT do:
#   - Touch the cloned Expediter repo (delete it yourself if you want).
#   - Touch Claude Code, Homebrew, tmux, or Bun (each has its own uninstaller).
#   - Remove ~/.local/bin from PATH in your shell rc — that directory is shared
#     with other tools (Claude Code installs into it too).
#   - Touch ~/.expediter/config.json if you created one (we never created it).
#   - Delete install-time backups (*.expediter-bak.<timestamp>).

set -uo pipefail

PORT="${EXPEDITER_PORT:-5179}"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
SHIM_EXPEDITER="$HOME/.local/bin/expediter"
SHIM_CLAUDEX="$HOME/.local/bin/claudex"
CONFIG_DIR="$HOME/.config/expediter"
CONFIG_FILE="$CONFIG_DIR/config"
SETTINGS="$HOME/.claude/settings.json"
TMUX_CONF="$HOME/.tmux.conf"
INSTALL_LOG="$HOME/.expediter-install.log"

# --- flags -----------------------------------------------------------------
# Default is quiet: one spinner line during the work, then a final success
# message. Pass --verbose / -v to see the full per-phase output (banner,
# section headers, ✓/⊘ status lines) that this script used to print
# unconditionally.

VERBOSE=0
for arg in "$@"; do
	case "$arg" in
		--verbose|-v) VERBOSE=1 ;;
		--help|-h)
			cat <<EOF
Usage: ./uninstall.sh [--verbose|-v] [--help|-h]

  --verbose, -v  Show the full per-phase output (banner, sections, status lines).
                 Default is a single spinner plus the final message.
  --help, -h     Show this message and exit.
EOF
			exit 0
			;;
	esac
done

# --- helpers ---------------------------------------------------------------

err() { printf '%s\n' "$*" >&2; }

# --- presentation helpers --------------------------------------------------
# Mirror install.sh's presentation layer. Inlined (~80 lines duplicated) so
# the uninstall script stays self-contained.

if [ -t 1 ]; then
	BOLD=$'\033[1m'
	DIM=$'\033[2m'
	GREEN=$'\033[38;2;0;114;0m'
	RESET=$'\033[0m'
else
	BOLD='' DIM='' GREEN='' RESET=''
fi

# Per-phase spinner frame sets, same as install.sh.
SPIN_HEAVY=(⣾ ⣽ ⣻ ⢿ ⡿ ⣟ ⣯ ⣷)
SPIN_CIRCLE=(◐ ◓ ◑ ◒)
SPIN_CLASSIC=('|' '/' '-' '\')
SPIN_FRAMES=("${SPIN_HEAVY[@]}")

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

spinner() {
	local running="$1"
	local success="$2"
	shift 2
	local code=0
	if [ -t 1 ]; then
		"$@" &
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
		"$@" || code=$?
	fi
	if [ "$code" -eq 0 ]; then
		printf '%s✓%s %s\n' "$GREEN" "$RESET" "$success"
	else
		printf '⚠ %s failed.\n' "$running" >&2
		exit 1
	fi
}

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
	err "The expediter uninstaller runs on macOS only. Sorry!"
	exit 1
fi

if [ "$VERBOSE" = 1 ]; then
	banner "uninstaller"
	printf '\n'
fi

# --- 1. Daemon check -------------------------------------------------------

SPIN_FRAMES=("${SPIN_HEAVY[@]}")
if [ "$VERBOSE" = 1 ]; then
	section "1. Daemon check"
	printf 'Making sure the expediter daemon is not currently running.\n\n'

	# Static one-frame flash — port-probing curl is instant.
	if [ -t 1 ]; then
		printf '%s%s%s Checking port %s ...' "$GREEN" "${SPIN_FRAMES[0]}" "$RESET" "$PORT"
		sleep 0.2
		printf '\r\033[K'
	fi
fi

# curl -w '%{http_code}' prints "000" on connection failure. Any 3-digit code
# starting with 1-5 means *something* answered HTTP on the port (almost
# certainly the daemon — port 5179 is its documented default). We bail rather
# than guess whether to kill it, because killing the daemon out from under a
# user's `expediter` foreground process would be surprising.
STATUS=$(curl -s -o /dev/null -m 1 -w '%{http_code}' "http://127.0.0.1:${PORT}/" 2>/dev/null || echo 000)
if [[ "$STATUS" =~ ^[1-5][0-9]{2}$ ]]; then
	printf '%s⚠%s Something is listening on http://127.0.0.1:%s/ — likely the expediter daemon.\n\n' "$RESET" "$RESET" "$PORT"
	printf 'Stop the daemon first (Ctrl-C in the terminal running `expediter`, or kill the bun process), then re-run this script.\n'
	exit 1
fi
[ "$VERBOSE" = 1 ] && printf '%s✓%s Port %s is free.\n' "$GREEN" "$RESET" "$PORT"

# --- 2. Confirmation -------------------------------------------------------

if [ "$VERBOSE" = 1 ]; then
	printf '\nThis will remove the expediter shims, the config file, the hook entries\n'
	printf 'from your claude code settings, the source-file line from your tmux conf,\n'
	printf 'and the install log. It will NOT touch the cloned repo, claude code,\n'
	printf 'homebrew, tmux, bun, your PATH, or any install-time backups.\n\n'
else
	printf 'This will uninstall expediter. '
fi
prompt_keypress "yn" "Continue? (y / n) "
if [ "$REPLY" != "y" ]; then
	printf '\nCancelled.\n'
	exit 0
fi

# In quiet mode, kick off a background spinner showing "Uninstalling
# expediter..." and route the per-step section output to /dev/null. Stderr
# stays connected so any failure (e.g. invalid settings.json) is still seen.
SPINNER_PID=""
if [ "$VERBOSE" = 0 ]; then
	if [ -t 1 ]; then
		(
			i=0
			n=${#SPIN_FRAMES[@]}
			while true; do
				printf '\r%s%s%s Uninstalling expediter...' "$GREEN" "${SPIN_FRAMES[i % n]}" "$RESET"
				sleep 0.08
				i=$((i+1))
			done
		) &
		SPINNER_PID=$!
	fi
	exec 3>&1
	exec >/dev/null
fi

# --- 3. Shims --------------------------------------------------------------

section "2. Shims"
printf 'Removing the expediter and claudex commands from ~/.local/bin/.\n\n'

removed_shims=0
for shim in "$SHIM_EXPEDITER" "$SHIM_CLAUDEX"; do
	if [ -f "$shim" ] || [ -L "$shim" ]; then
		rm -f "$shim"
		removed_shims=$((removed_shims + 1))
	fi
done
if [ "$removed_shims" = 0 ]; then
	printf '%s⊘%s No shims to remove.\n' "$DIM" "$RESET"
else
	printf '%s✓%s Removed %d shim(s).\n' "$GREEN" "$RESET" "$removed_shims"
fi

# --- 4. Config -------------------------------------------------------------

section "3. Config"
printf 'Removing ~/.config/expediter/.\n\n'

removed_config=0
if [ -f "$CONFIG_FILE" ]; then
	rm -f "$CONFIG_FILE"
	removed_config=1
fi
if [ -d "$CONFIG_DIR" ]; then
	# rmdir refuses non-empty dirs, so a user file we never created stays put.
	if rmdir "$CONFIG_DIR" 2>/dev/null; then
		removed_config=1
	fi
fi
if [ "$removed_config" = 1 ]; then
	printf '%s✓%s Removed config file and directory.\n' "$GREEN" "$RESET"
else
	printf '%s⊘%s Config already gone.\n' "$DIM" "$RESET"
fi

# --- 5. Hooks --------------------------------------------------------------

section "4. Hooks"
printf 'Removing expediter hook entries from ~/.claude/settings.json.\n'
printf 'A timestamped backup of settings.json is saved first.\n\n'

if [ -f "$SETTINGS" ] && grep -Fq "expediter-hook.sh" "$SETTINGS"; then
	BACKUP="$SETTINGS.expediter-uninstall-bak.$TIMESTAMP"
	cp "$SETTINGS" "$BACKUP"
	printf '%s✓%s Backed up settings.json → %s\n' "$GREEN" "$RESET" "$BACKUP"

	# Refuse to touch the file if it's not valid JSON or not the expected
	# shape. Walk hooks.<EventName> block arrays, drop any matcher block whose
	# `command` references our hook script, trim empty event keys / empty
	# hooks dict. Prints the removed-block count to stdout for the caller.
	count=$(python3 - "$SETTINGS" <<'PY'
import json, sys

settings_path = sys.argv[1]

with open(settings_path) as f:
    try:
        data = json.load(f)
    except json.JSONDecodeError as e:
        sys.stderr.write(f"settings.json is not valid JSON: {e}\n")
        sys.stderr.write("Refusing to touch it. Edit it manually or restore the backup.\n")
        sys.exit(1)

if not isinstance(data, dict):
    sys.stderr.write("settings.json top-level must be an object. Refusing to touch it.\n")
    sys.exit(1)

hooks = data.get("hooks")
if not isinstance(hooks, dict):
    print(0)
    sys.exit(0)

removed = 0
empty_event_keys = []

for event, blocks in list(hooks.items()):
    if not isinstance(blocks, list):
        continue
    kept = []
    for block in blocks:
        if not isinstance(block, dict):
            kept.append(block)
            continue
        cmds = (block.get("hooks") or [])
        is_ours = any(
            isinstance(h, dict)
            and "expediter-hook.sh" in str(h.get("command", ""))
            for h in cmds
        )
        if is_ours:
            removed += 1
        else:
            kept.append(block)
    if kept:
        hooks[event] = kept
    else:
        empty_event_keys.append(event)

for k in empty_event_keys:
    del hooks[k]

if not hooks:
    del data["hooks"]

with open(settings_path, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")

print(removed)
PY
)
	printf '%s✓%s Removed %s expediter hook block(s) from settings.json.\n' "$GREEN" "$RESET" "$count"
else
	printf '%s⊘%s No expediter entries in settings.json (or settings.json absent).\n' "$DIM" "$RESET"
fi

# --- 6. tmux.conf ----------------------------------------------------------

section "5. Tmux config"
printf 'Removing the source-file line for expediter.tmux.conf from ~/.tmux.conf.\n'
printf 'A timestamped backup is saved first.\n\n'

if [ -f "$TMUX_CONF" ] && grep -Fq "expediter.tmux.conf" "$TMUX_CONF"; then
	BACKUP="$TMUX_CONF.expediter-uninstall-bak.$TIMESTAMP"
	cp "$TMUX_CONF" "$BACKUP"
	printf '%s✓%s Backed up ~/.tmux.conf → %s\n' "$GREEN" "$RESET" "$BACKUP"

	# install.sh writes one of two shapes:
	#   - file-created-from-scratch: "# Created by Expediter installer\n
	#     source-file ...\n" (2 lines, the only content).
	#   - appended to existing:      "\n# Added by Expediter installer\n
	#     source-file ...\n".
	# Splice the source-file line and the preceding "# Added/Created by..."
	# comment (and a blank line above the comment, if install.sh appended
	# one). If the file ends up empty after the splice, delete it.
	deleted_file=$(python3 - "$TMUX_CONF" <<'PY'
import sys
from pathlib import Path

conf_path = Path(sys.argv[1])
lines = conf_path.read_text().splitlines()

new_lines = []
removed = 0
for line in lines:
    if "expediter.tmux.conf" in line and "source-file" in line:
        if new_lines and (
            new_lines[-1].strip().startswith("# Added by Expediter installer")
            or new_lines[-1].strip().startswith("# Created by Expediter installer")
        ):
            new_lines.pop()
        if new_lines and new_lines[-1].strip() == "":
            new_lines.pop()
        removed += 1
        continue
    new_lines.append(line)

while new_lines and new_lines[-1].strip() == "":
    new_lines.pop()

if not new_lines:
    conf_path.unlink()
    print(f"deleted:{removed}")
else:
    conf_path.write_text("\n".join(new_lines) + "\n")
    print(f"kept:{removed}")
PY
)
	if [[ "$deleted_file" == deleted:* ]]; then
		count="${deleted_file#deleted:}"
		printf '%s✓%s ~/.tmux.conf had only our lines; deleted the file (%s expediter line(s) removed).\n' "$GREEN" "$RESET" "$count"
	else
		count="${deleted_file#kept:}"
		printf '%s✓%s Removed %s expediter source-file line(s) from ~/.tmux.conf.\n' "$GREEN" "$RESET" "$count"
	fi
else
	printf '%s⊘%s No expediter entries in ~/.tmux.conf (or no .tmux.conf).\n' "$DIM" "$RESET"
fi

# --- 7. Install log --------------------------------------------------------

section "6. Install log"
printf 'Removing ~/.expediter-install.log.\n\n'

if [ -f "$INSTALL_LOG" ]; then
	rm -f "$INSTALL_LOG"
	printf '%s✓%s Removed install log.\n' "$GREEN" "$RESET"
else
	printf '%s⊘%s Install log already gone.\n' "$DIM" "$RESET"
fi

# --- done ------------------------------------------------------------------

# Tear down the quiet-mode spinner and restore the original stdout before
# printing the final message so the success line is visible.
if [ "$VERBOSE" = 0 ]; then
	exec 1>&3
	if [ -n "$SPINNER_PID" ]; then
		kill "$SPINNER_PID" 2>/dev/null
		wait "$SPINNER_PID" 2>/dev/null
	fi
	printf '\r\033[K'
fi

printf '\n%s✦%s Expediter is gone.\n\n' "$GREEN" "$RESET"
printf 'Bon voyage 🚢\n'
