#!/usr/bin/env bash
# update.sh - refresh an existing Expediter install in place on macOS.
#
# Run from the cloned repo (or via `expediter update`):
#   ./update.sh            pull the latest, then rebuild + re-sync
#   ./update.sh --dev      skip the pull; rebuild the current checkout as-is
#
# This is the fast path that replaces the old uninstall.sh + install.sh dance.
# It assumes Expediter is already installed (see ./install.sh for a first-time
# setup) and only refreshes the parts that actually go stale:
#   1. Pulls the latest source (fast-forward only; skipped with --dev, on a
#      dirty checkout, or when the branch has diverged - see the Sync phase).
#   2. Rebuilds the app (bun install + bun run build → build/index.js).
#   3. Rewrites the `expediter` / `claudex` shims and the config file, and
#      re-copies the cc-clock / cc-dates status-bar helpers (which install.sh
#      copies into ~/.local/bin rather than referencing from the repo).
#   4. Re-merges Expediter's hook entries into ~/.claude/settings.json so any
#      newly added events are registered. Idempotent; backs up first.
#
# What it does NOT do:
#   - Re-check or install Claude Code, tmux, Homebrew, or Bun.
#   - Touch your PATH or ~/.tmux.conf (the tmux conf is sourced from the repo,
#     so edits there take effect on the next tmux reload).
#   - Force or merge during the pull - only a clean fast-forward. Local edits
#     and diverged history are left untouched (it builds what's on disk).
#   - Stop a running daemon. Rebuilding under a live process is safe; you just
#     restart it afterwards to pick up the new build.

set -euo pipefail

LOG="$HOME/.expediter-update.log"
: > "$LOG"
PORT="${EXPEDITER_PORT:-5179}"

# --- flags -----------------------------------------------------------------
# Default pulls the latest before rebuilding. --dev / --no-pull skips the pull
# so a feature-branch / worktree checkout (e.g. premain) is built as-is - handy
# when you're updating from a branch you don't want HEAD moved on.

PULL=1
for arg in "$@"; do
	case "$arg" in
		--no-pull|--dev) PULL=0 ;;
		--help|-h)
			cat <<EOF
Usage: ./update.sh [--dev|--no-pull] [--help|-h]

Refreshes an existing Expediter install in place: pulls the latest source
(fast-forward only), rebuilds, then re-syncs the shims, helpers, and hooks.

  --dev, --no-pull  Skip the git pull and build the current checkout as-is.
                    Use on a feature branch / worktree (e.g. premain) where
                    you don't want update.sh moving HEAD.
  --help, -h        Show this message and exit.
EOF
			exit 0
			;;
	esac
done

# --- helpers ---------------------------------------------------------------

err() { printf '%s\n' "$*" >&2; }

# --- presentation helpers --------------------------------------------------
# Mirror install.sh / uninstall.sh's presentation layer. Inlined so the update
# script stays self-contained.

if [ -t 1 ]; then
	BOLD=$'\033[1m'
	DIM=$'\033[2m'
	GREEN=$'\033[38;2;0;114;0m'
	RESET=$'\033[0m'
else
	BOLD='' DIM='' GREEN='' RESET=''
fi

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

# --- 0. preflight ----------------------------------------------------------

if [ "$(uname -s)" != "Darwin" ]; then
	err "The expediter updater runs on macOS only. Sorry!"
	exit 1
fi

REPO="$(cd "$(dirname "$0")" && pwd)"
if [ ! -f "$REPO/package.json" ]; then
	err "update.sh must be run from inside the cloned Expediter repo."
	exit 1
fi

# An update only makes sense if there's an install to update. The config file
# is install.sh's canonical "I ran successfully" marker.
if [ ! -f "$HOME/.config/expediter/config" ]; then
	err "Expediter doesn't look installed yet (no ~/.config/expediter/config)."
	err "Run ./install.sh first, then use ./update.sh for subsequent updates."
	exit 1
fi

# Detect a running daemon with the same probe uninstall.sh uses. Unlike the
# uninstaller we do NOT abort: a rebuild is safe while the daemon runs (Bun
# holds the old build/index.js in memory until it restarts). We just remember
# the state so we can advise a restart at the end.
DAEMON_RUNNING=0
STATUS=$(curl -s -o /dev/null -m 1 -w '%{http_code}' "http://127.0.0.1:${PORT}/" 2>/dev/null || echo 000)
if [[ "$STATUS" =~ ^[1-5][0-9]{2}$ ]]; then
	DAEMON_RUNNING=1
fi

banner "updater"
printf '\n'

# --- 1. Sync ---------------------------------------------------------------

SPIN_FRAMES=("${SPIN_HEAVY[@]}")
section "1. Sync"
printf 'Fetching the latest source before rebuilding.\n\n'

# .git is a directory in a normal clone but a *file* (a gitdir pointer) inside a
# worktree, so test for either with -e.
if [ "$PULL" = 0 ]; then
	printf '%s⊘%s Skipping git pull (--dev) - building the current checkout.\n' "$DIM" "$RESET"
elif [ ! -e "$REPO/.git" ]; then
	printf '%s⊘%s Not a git checkout - building the current files.\n' "$DIM" "$RESET"
else
	branch=$(git -C "$REPO" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')
	# Never pull over local edits: a stray change in the clone could conflict or
	# be clobbered. Build what's on disk and say why. (Untracked files don't
	# block a fast-forward, so they're not counted as "dirty" here.)
	if ! git -C "$REPO" diff --quiet 2>/dev/null || ! git -C "$REPO" diff --cached --quiet 2>/dev/null; then
		printf '%s⚠%s Local changes in the checkout - skipping pull, building %s as-is.\n' "$BOLD" "$RESET" "$branch"
	else
		before=$(git -C "$REPO" rev-parse HEAD 2>/dev/null || echo '')
		if git -C "$REPO" pull --ff-only >>"$LOG" 2>&1; then
			after=$(git -C "$REPO" rev-parse HEAD 2>/dev/null || echo '')
			if [ "$before" = "$after" ]; then
				printf '%s✓%s Already up to date (%s).\n' "$GREEN" "$RESET" "$branch"
			else
				printf '%s✓%s Pulled the latest on %s.\n' "$GREEN" "$RESET" "$branch"
			fi
		else
			# Diverged history, no upstream, or a fast-forward that would clobber an
			# untracked file. Don't force or merge - just build what's here.
			printf '%s⚠%s Could not fast-forward %s (diverged or no upstream) - building as-is. See %s.\n' "$BOLD" "$RESET" "$branch" "$LOG"
		fi
	fi
fi

# --- 2. Build --------------------------------------------------------------

SPIN_FRAMES=("${SPIN_HEAVY[@]}")
section "2. Build"
printf 'Rebuilding the app from the current source.\n\n'

# A fresh non-interactive shell may not have sourced the rc that puts Bun on
# PATH. Add Bun's default install dir defensively before giving up.
if ! command -v bun >/dev/null 2>&1; then
	[ -d "$HOME/.bun/bin" ] && export PATH="$HOME/.bun/bin:$PATH"
fi
if ! command -v bun >/dev/null 2>&1; then
	err "bun not found on PATH. Open a new terminal (so your shell rc loads bun),"
	err "or re-run ./install.sh, then retry ./update.sh."
	exit 1
fi

spinner "Installing dependencies ..." "Dependencies installed." bash -c "cd '$REPO' && bun install"
spinner "Building ..." "App built." bash -c "cd '$REPO' && bun run build"

# --- 2. Shims & helpers ----------------------------------------------------

SPIN_FRAMES=("${SPIN_CIRCLE[@]}")
section "3. Shims & helpers"
printf 'Refreshing the expediter / claudex commands, config, and status-bar helpers.\n\n'

# Rewrite the config (idempotent; also self-heals EXPEDITER_HOME if the repo
# moved). Byte-identical to what install.sh writes.
mkdir -p "$HOME/.config/expediter"
cat > "$HOME/.config/expediter/config" <<'EOF'
# expediter config - written by install.sh
# If you move the cloned repo, update EXPEDITER_HOME below (or re-run install.sh).
# The `export` is load-bearing: the shims source this file and exec bun, which
# is a child process - without `export`, EXPEDITER_HOME would be a shell var and
# would not propagate to bun's environment, causing bin/expediter.mjs to abort.
EOF
printf 'export EXPEDITER_HOME="%s"\n' "$REPO" >> "$HOME/.config/expediter/config"

# Rewrite the two shims (byte-identical to install.sh).
mkdir -p "$HOME/.local/bin"
cat > "$HOME/.local/bin/expediter" <<'EOF'
#!/usr/bin/env bash
# expediter shim - installed by install.sh. Reads ~/.config/expediter/config
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
# claudex shim - installed by install.sh.
config="$HOME/.config/expediter/config"
if [ ! -f "$config" ]; then
	echo "claudex: missing $config. Re-run install.sh from the cloned repo." >&2
	exit 1
fi
# shellcheck disable=SC1090
. "$config"
# Re-export defensively - claudex.sh and any child process needs it in env.
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

# Re-copy the status-bar helpers. These are the one part install.sh copies into
# ~/.local/bin rather than referencing from the repo, so they go stale on an
# update unless re-copied. cc-dates silently no-ops if `jq` isn't installed.
for helper in cc-clock cc-dates; do
	cp "$REPO/bin/$helper" "$HOME/.local/bin/$helper"
	chmod +x "$HOME/.local/bin/$helper"
done

printf '%s✓%s Shims, config, and helpers refreshed.\n' "$GREEN" "$RESET"

# --- 3. Hooks --------------------------------------------------------------

SPIN_FRAMES=("${SPIN_HEAVY[@]}")
section "4. Hooks"
printf 'Re-syncing expediter hook entries in ~/.claude/settings.json.\n'
printf 'A timestamped backup is saved first if the file exists.\n\n'

# Same merge install.sh uses: idempotent (dedupes on matcher + hook script), so
# re-running picks up any events added since the last install without
# duplicating existing ones.
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

# (event_name, matcher) tuples. SessionStart's matcher accepts only single
# exact strings (not regex / pipe-alternation), so it is registered three times
# - once per source value we care about. `compact` is intentionally omitted to
# avoid an auto-compaction gray flash on a working ticket.
EVENTS = [
    ("Stop", ""),
    ("PermissionRequest", ""),
    ("Notification", ""),
    ("UserPromptSubmit", ""),
    ("PostToolUse", ""),
    ("PostToolUseFailure", ""),
    ("SessionEnd", ""),
    ("SessionStart", "startup"),
    ("SessionStart", "resume"),
    ("SessionStart", "clear"),
]

if os.path.exists(settings_path):
    with open(settings_path) as f:
        try:
            data = json.load(f)
        except json.JSONDecodeError as e:
            sys.stderr.write(f"settings.json is not valid JSON: {e}\n")
            sys.stderr.write("Refusing to overwrite. Fix it manually and re-run update.sh.\n")
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
for ev, matcher in EVENTS:
    blocks = hooks.setdefault(ev, [])
    if not isinstance(blocks, list):
        sys.stderr.write(f"settings.json hooks.{ev} must be a list. Skipping.\n")
        continue
    already = False
    for block in blocks:
        if not isinstance(block, dict):
            continue
        # Dedupe key is (matcher, hook_script-in-command). Without the matcher
        # component, the three SessionStart blocks (startup / resume / clear)
        # would collapse to one - the first wins and the other two are silently
        # dropped.
        if block.get("matcher", "") != matcher:
            continue
        for h in block.get("hooks", []) or []:
            if isinstance(h, dict) and hook_script in str(h.get("command", "")):
                already = True
                break
        if already:
            break
    if already:
        skipped += 1
        continue
    blocks.append({
        "matcher": matcher,
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
printf '%s✓%s Hooks synced.\n' "$GREEN" "$RESET"

# --- done ------------------------------------------------------------------

printf '\n%s✦%s Expediter updated!\n\n' "$GREEN" "$RESET"

# The rebuild rewrote build/index.js on disk, but a daemon that was already
# running loaded the old build into memory at startup and won't notice. Flag it
# so the update doesn't silently appear to do nothing. We only instruct - never
# kill a foreground process living in another terminal (uninstall.sh refuses to
# for the same reason).
if [ "$DAEMON_RUNNING" = 1 ]; then
	printf '%s⚠%s  The daemon is still running the previous build (port %s).\n' "$BOLD" "$RESET" "$PORT"
	printf '   To load this update, restart it: Ctrl-C the %sexpediter%s terminal, then run %sexpediter%s again.\n\n' "$BOLD" "$RESET" "$BOLD" "$RESET"
fi
