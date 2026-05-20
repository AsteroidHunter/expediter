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

# --- helpers ---------------------------------------------------------------

log() { printf '%s\n' "$*"; }
err() { printf '%s\n' "$*" >&2; }

# prompt_yn "Question? [y/N]"  — defaults to NO on empty input (destructive op).
prompt_yn() {
	local q="$1" reply
	printf '%s ' "$q"
	read -r reply
	case "${reply:-n}" in
		y|Y|yes|YES) return 0 ;;
		*) return 1 ;;
	esac
}

# --- 0. preflight ----------------------------------------------------------

if [ "$(uname -s)" != "Darwin" ]; then
	err "Expediter uninstaller currently supports macOS only."
	exit 1
fi

log "Expediter uninstaller"
log ""

# --- 1. Daemon-running check -----------------------------------------------

# curl -w '%{http_code}' prints "000" on connection failure. Any 3-digit code
# starting with 1-5 means *something* answered HTTP on the port (almost
# certainly the daemon — port 5179 is its documented default). We bail rather
# than guess whether to kill it, because killing the daemon out from under a
# user's `expediter` foreground process would be surprising.
STATUS=$(curl -s -o /dev/null -m 1 -w '%{http_code}' "http://127.0.0.1:${PORT}/" 2>/dev/null || echo 000)
if [[ "$STATUS" =~ ^[1-5][0-9]{2}$ ]]; then
	err "Something is listening on http://127.0.0.1:${PORT}/ — likely the Expediter daemon."
	err ""
	err "Stop it first (Ctrl-C in the terminal running \`expediter\`, or kill"
	err "the bun process), then re-run this script."
	exit 1
fi

# --- 2. Confirmation -------------------------------------------------------

log "This will:"
log "  - remove ~/.local/bin/expediter and ~/.local/bin/claudex"
log "  - remove ~/.config/expediter/"
log "  - remove Expediter's hook entries from ~/.claude/settings.json (if present)"
log "  - remove Expediter's source-file line from ~/.tmux.conf (if present)"
log "  - remove ~/.expediter-install.log"
log ""
log "It will NOT touch:"
log "  - the cloned Expediter repo"
log "  - Claude Code, Homebrew, tmux, or Bun"
log "  - the PATH entry for ~/.local/bin in your shell rc (it's shared)"
log "  - any *.expediter-bak.<timestamp> files left by install.sh"
log ""

if ! prompt_yn "Continue? [y/N]"; then
	log "Cancelled."
	exit 0
fi

# --- 3. Shims --------------------------------------------------------------

log ""
removed_shims=0
for shim in "$SHIM_EXPEDITER" "$SHIM_CLAUDEX"; do
	if [ -f "$shim" ] || [ -L "$shim" ]; then
		rm -f "$shim"
		log "Removed $shim"
		removed_shims=$((removed_shims + 1))
	fi
done
if [ "$removed_shims" = 0 ]; then
	log "No shims to remove."
fi

# --- 4. Config file + dir --------------------------------------------------

if [ -f "$CONFIG_FILE" ]; then
	rm -f "$CONFIG_FILE"
	log "Removed $CONFIG_FILE"
fi
if [ -d "$CONFIG_DIR" ]; then
	# rmdir refuses non-empty dirs, so a user file we never created stays put.
	if rmdir "$CONFIG_DIR" 2>/dev/null; then
		log "Removed $CONFIG_DIR"
	else
		log "Kept $CONFIG_DIR — directory is not empty."
	fi
fi

# --- 5. Hooks in ~/.claude/settings.json -----------------------------------

if [ -f "$SETTINGS" ]; then
	if grep -Fq "expediter-hook.sh" "$SETTINGS"; then
		BACKUP="$SETTINGS.expediter-uninstall-bak.$TIMESTAMP"
		cp "$SETTINGS" "$BACKUP"
		log "Backed up $SETTINGS to $BACKUP"

		# Mirror install.sh's safety checks: refuse to touch the file if it's
		# not valid JSON or not the expected shape. Walk hooks.<EventName>
		# block arrays, drop any matcher block whose `command` references our
		# hook script, and trim empty event keys / empty hooks dict.
		python3 - "$SETTINGS" <<'PY'
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
    print("No hooks block; nothing to remove.")
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

print(f"Removed {removed} Expediter hook block(s) from settings.json.")
PY
	else
		log "No Expediter entries in $SETTINGS — skipping."
	fi
else
	log "No $SETTINGS — skipping hooks step."
fi

# --- 6. tmux.conf ----------------------------------------------------------

if [ -f "$TMUX_CONF" ]; then
	if grep -Fq "expediter.tmux.conf" "$TMUX_CONF"; then
		BACKUP="$TMUX_CONF.expediter-uninstall-bak.$TIMESTAMP"
		cp "$TMUX_CONF" "$BACKUP"
		log "Backed up $TMUX_CONF to $BACKUP"

		# install.sh writes one of two shapes:
		#   - file-created-from-scratch: "# Created by Expediter installer\n
		#     source-file ...\n" (2 lines, the only content).
		#   - appended to existing:      "\n# Added by Expediter installer\n
		#     source-file ...\n".
		# Splice the source-file line and the preceding "# Added/Created by..."
		# comment (and a blank line above the comment, if install.sh appended
		# one). If the file ends up empty after the splice, delete it.
		python3 - "$TMUX_CONF" <<'PY'
import sys
from pathlib import Path

conf_path = Path(sys.argv[1])
lines = conf_path.read_text().splitlines()

new_lines = []
removed = 0
for line in lines:
    if "expediter.tmux.conf" in line and "source-file" in line:
        # Drop the immediately preceding Expediter installer comment, if any.
        if new_lines and (
            new_lines[-1].strip().startswith("# Added by Expediter installer")
            or new_lines[-1].strip().startswith("# Created by Expediter installer")
        ):
            new_lines.pop()
        # Drop a single blank line above the comment (install.sh appends one).
        if new_lines and new_lines[-1].strip() == "":
            new_lines.pop()
        removed += 1
        continue
    new_lines.append(line)

# Strip trailing blank lines so a previously-tidy file stays tidy.
while new_lines and new_lines[-1].strip() == "":
    new_lines.pop()

if not new_lines:
    conf_path.unlink()
    print(f"~/.tmux.conf contained only Expediter's lines — deleted the file ({removed} line(s) removed).")
else:
    conf_path.write_text("\n".join(new_lines) + "\n")
    print(f"Removed {removed} Expediter source-file line(s) from ~/.tmux.conf.")
PY
	else
		log "No Expediter entries in $TMUX_CONF — skipping."
	fi
else
	log "No $TMUX_CONF — skipping tmux step."
fi

# --- 7. Install log --------------------------------------------------------

if [ -f "$INSTALL_LOG" ]; then
	rm -f "$INSTALL_LOG"
	log "Removed $INSTALL_LOG"
fi

# --- done ------------------------------------------------------------------

log ""
log "Done."
log ""
log "If you also want to remove things this script did not touch:"
log "  - The cloned Expediter repo:    rm -rf <path-to-clone>"
log "  - Claude Code:                  https://docs.claude.com/en/docs/claude-code/setup"
log "  - Homebrew / tmux / Bun:        each has its own uninstall path"
log "  - PWA on your phone:            remove the home-screen icon and clear"
log "                                  Safari site data for the LAN URL"
log "  - Once you've confirmed nothing is broken, the *.expediter-bak.* and"
log "    *.expediter-uninstall-bak.* files next to settings.json and tmux.conf"
log "    can be deleted too."
