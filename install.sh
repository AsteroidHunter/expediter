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

log() { printf '%s\n' "$*"; }
err() { printf '%s\n' "$*" >&2; }

# prompt_yn "Question? [y/n]"  — defaults to yes on empty input.
prompt_yn() {
	local q="$1" reply
	printf '%s ' "$q"
	read -r reply
	case "${reply:-y}" in
		y|Y|yes|YES) return 0 ;;
		*) return 1 ;;
	esac
}

run_quiet() {
	if ! "$@" >>"$LOG" 2>&1; then
		err "Step failed: $*"
		err "See $LOG for details."
		exit 1
	fi
}

# --- 0. preflight ----------------------------------------------------------

if [ "$(uname -s)" != "Darwin" ]; then
	err "Expediter currently supports macOS only."
	exit 1
fi

log "Expediter installer"
log "Repo: $REPO"
log ""

# --- 1. Claude Code --------------------------------------------------------

if command -v claude >/dev/null 2>&1; then
	log "Claude Code detected."
else
	log "Claude Code is not installed."
	log ""
	log "(Required — Expediter bridges Claude Code hook events into a local daemon.)"
	log ""
	if prompt_yn "Install Claude Code now? [y/n]"; then
		log "Installing Claude Code..."
		run_quiet bash -c 'curl -fsSL https://claude.ai/install.sh | bash'
		# Native installer drops the binary at ~/.local/bin/claude.
		export PATH="$HOME/.local/bin:$PATH"
		if ! command -v claude >/dev/null 2>&1; then
			err "Claude Code install completed but `claude` is still not on PATH."
			err "Open a new terminal and re-run this script."
			exit 1
		fi
		log "Claude Code installed."
	else
		log ""
		log "Stopping. Install Claude Code manually, then re-run this script:"
		log "  https://docs.claude.com/en/docs/claude-code/setup"
		exit 1
	fi
fi

# --- 2. System tools (tmux, brew, bun) -------------------------------------

NEED_BREW=0; NEED_TMUX=0; NEED_BUN=0
command -v brew >/dev/null 2>&1 || NEED_BREW=1
command -v tmux >/dev/null 2>&1 || NEED_TMUX=1
command -v bun  >/dev/null 2>&1 || NEED_BUN=1

if [ "$NEED_TMUX" = 0 ] && [ "$NEED_BREW" = 0 ] && [ "$NEED_BUN" = 0 ]; then
	log "tmux, Homebrew, Bun detected."
else
	log ""
	if [ "$NEED_TMUX" = 1 ]; then
		log "tmux is not installed."
	else
		log "tmux detected, but other tools are missing."
	fi
	log ""
	log "(also installs Homebrew and Bun automatically if they're not already on your system — both are standard developer tools)"
	log ""
	if prompt_yn "Install missing tools? [y/n]"; then
		# Homebrew first — needed for tmux. The official installer prompts for
		# sudo (unavoidable) and may trigger an Xcode CLT install on a fresh Mac.
		if [ "$NEED_BREW" = 1 ]; then
			log "Installing Homebrew (this can take a few minutes; you may be prompted for your Mac password)..."
			run_quiet bash -c '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'
			# Make brew available in the current shell. On Apple Silicon brew
			# lives at /opt/homebrew; on Intel at /usr/local.
			if [ -x /opt/homebrew/bin/brew ]; then
				eval "$(/opt/homebrew/bin/brew shellenv)"
			elif [ -x /usr/local/bin/brew ]; then
				eval "$(/usr/local/bin/brew shellenv)"
			fi
			log "Homebrew installed."
		fi
		if [ "$NEED_TMUX" = 1 ]; then
			log "Installing tmux..."
			run_quiet brew install tmux
			log "tmux installed."
		fi
		if [ "$NEED_BUN" = 1 ]; then
			log "Installing Bun..."
			run_quiet bash -c 'curl -fsSL https://bun.sh/install | bash'
			# Bun installer drops the binary at ~/.bun/bin/bun and patches the
			# user's shell rc, but the current shell needs PATH updated.
			export BUN_INSTALL="$HOME/.bun"
			export PATH="$BUN_INSTALL/bin:$PATH"
			log "Bun installed."
		fi
	else
		log ""
		log "Stopping. Install the missing tools manually and re-run this script."
		exit 1
	fi
fi

# --- 3. Build --------------------------------------------------------------

log ""
log "Installing dependencies..."
( cd "$REPO" && run_quiet bun install )

log "Building..."
( cd "$REPO" && run_quiet bun run build )

# --- 4. Config file --------------------------------------------------------

mkdir -p "$HOME/.config/expediter"
cat > "$HOME/.config/expediter/config" <<EOF
# expediter config — written by install.sh
# If you move the cloned repo, update EXPEDITER_HOME below (or re-run install.sh).
# The `export` is load-bearing: the shims source this file and exec bun, which
# is a child process — without `export`, EXPEDITER_HOME would be a shell var and
# would not propagate to bun's environment, causing bin/expediter.mjs to abort.
export EXPEDITER_HOME="$REPO"
EOF
log "Wrote $HOME/.config/expediter/config"

# --- 5. Shims --------------------------------------------------------------

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

log "Installed shims: ~/.local/bin/expediter, ~/.local/bin/claudex"

# --- 6. PATH ---------------------------------------------------------------

case ":$PATH:" in
	*":$HOME/.local/bin:"*) ;;
	*)
		# zsh is the macOS default; fall back to ~/.bashrc only if no zshrc exists.
		SHELL_RC="$HOME/.zshrc"
		if [ ! -f "$SHELL_RC" ] && [ -f "$HOME/.bashrc" ]; then
			SHELL_RC="$HOME/.bashrc"
		fi
		printf '\n# Added by Expediter installer\nexport PATH="$HOME/.local/bin:$PATH"\n' >> "$SHELL_RC"
		log "Added ~/.local/bin to PATH in $SHELL_RC."
		log "Open a new terminal (or run: source $SHELL_RC) before using expediter/claudex."
		;;
esac

# --- 7. Claude Code hooks --------------------------------------------------

log ""
if prompt_yn "Add Expediter hooks to ~/.claude/settings.json? (backup saved next to it) [y/n]"; then
	mkdir -p "$HOME/.claude"
	SETTINGS="$HOME/.claude/settings.json"
	HOOK_SCRIPT="$REPO/bin/expediter-hook.sh"

	# Back up existing settings (if any). Skipped if the file doesn't exist.
	if [ -f "$SETTINGS" ]; then
		BACKUP="$SETTINGS.expediter-bak.$(date +%Y%m%d-%H%M%S)"
		cp "$SETTINGS" "$BACKUP"
		log "Backed up existing settings to $BACKUP"
	fi

	# Merge with python3 (always present on macOS). For each of the 7 event
	# names, append a new matcher block running our hook script — but skip if
	# any existing matcher block already references this exact hook path
	# (idempotency: re-running install.sh shouldn't duplicate entries).
	python3 - "$SETTINGS" "$HOOK_SCRIPT" <<'PY'
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
            sys.stderr.write("Refusing to overwrite. Fix it and re-run install.sh, or merge manually from docs/hooks-config-example.json.\n")
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
fi

# --- 8. tmux conf ----------------------------------------------------------

log ""
if prompt_yn "Apply Expediter tmux styling? (your existing conf will be backed up) [y/n]"; then
	TMUX_CONF="$HOME/.tmux.conf"
	SOURCE_LINE="source-file \"$REPO/expediter.tmux.conf\""

	if [ -f "$TMUX_CONF" ]; then
		if grep -Fq "$REPO/expediter.tmux.conf" "$TMUX_CONF"; then
			log "tmux conf already sources expediter.tmux.conf — skipping."
		else
			BACKUP="$TMUX_CONF.expediter-bak.$(date +%Y%m%d-%H%M%S)"
			cp "$TMUX_CONF" "$BACKUP"
			log "Backed up existing $TMUX_CONF to $BACKUP"
			printf '\n# Added by Expediter installer\n%s\n' "$SOURCE_LINE" >> "$TMUX_CONF"
			log "Appended source-file line to $TMUX_CONF"
		fi
	else
		printf '# Created by Expediter installer\n%s\n' "$SOURCE_LINE" > "$TMUX_CONF"
		log "Created $TMUX_CONF sourcing expediter.tmux.conf"
	fi
fi

# --- done ------------------------------------------------------------------

log ""
log "Done."
log ""
log "Quick start:"
log "  expediter         — start the daemon and print URL + QR code"
log "  claudex           — open tmux with claude + expediter side-by-side"
log ""
log "Install log: $LOG"
