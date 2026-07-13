#!/usr/bin/env bash
# install-remote.sh — set up the Expediter mini-client on a REMOTE box.
#
# Run this ON the remote machine (the one you ssh into and run claude on),
# after copying it there together with the hook script:
#
#   scp install-remote.sh bin/expediter-hook.sh <host>:
#   ssh <host> bash install-remote.sh
#
# (Running it from a full clone of the repo works too.)
#
# What it does — everything stays inside YOUR home directory; nothing on the
# (possibly shared) box's system config is touched, and no root is needed:
#   1. Checks for python3 and curl; refuses loudly if either is missing.
#   2. Copies expediter-hook.sh → ~/.expediter/bin/ and marks it executable.
#   3. Merges Expediter's hook entries into ~/.claude/settings.json
#      (timestamped backup first; refuses to touch invalid JSON; re-runs are
#      deduped, never stacked).
#
# How it works afterwards: the hook script detects it is in an ssh session
# (no $TMUX_PANE, $SSH_CONNECTION set) and POSTs each claude event to
# localhost:5179 — which the RemoteForward tunnel, written into the Mac's
# ~/.ssh/config by the main installer, carries back to the Mac daemon. Steady
# state is zero-friction: `ssh <host>`, run `claude`, tickets appear.

set -euo pipefail

err() { printf '%s\n' "$*" >&2; }

# --- 1. prerequisites --------------------------------------------------------

MISSING=""
command -v python3 >/dev/null 2>&1 || MISSING="python3"
if ! command -v curl >/dev/null 2>&1; then
	MISSING="${MISSING:+$MISSING and }curl"
fi
if [ -n "$MISSING" ]; then
	err "⚠ The expediter mini-client needs $MISSING on this machine."
	err "  Install $MISSING (no root needed if your distro offers user-space packages,"
	err "  otherwise ask the box's admin) and re-run this script."
	exit 1
fi

# --- 2. hook script ----------------------------------------------------------

# Locate expediter-hook.sh relative to this script: bin/ sibling when run from
# a repo clone, same directory when the two files were scp'd together.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOOK_SOURCE=""
for candidate in "$SCRIPT_DIR/bin/expediter-hook.sh" "$SCRIPT_DIR/expediter-hook.sh"; do
	if [ -f "$candidate" ]; then
		HOOK_SOURCE="$candidate"
		break
	fi
done
if [ -z "$HOOK_SOURCE" ]; then
	err "⚠ Cannot find expediter-hook.sh next to this script."
	err "  Copy it alongside install-remote.sh (scp install-remote.sh bin/expediter-hook.sh <host>:)"
	err "  and re-run."
	exit 1
fi

HOOK_DIR="$HOME/.expediter/bin"
HOOK_SCRIPT="$HOOK_DIR/expediter-hook.sh"
mkdir -p "$HOOK_DIR"
cp "$HOOK_SOURCE" "$HOOK_SCRIPT"
chmod +x "$HOOK_SCRIPT"
printf '✓ Hook script installed at %s\n' "$HOOK_SCRIPT"

# --- 3. hook entries ---------------------------------------------------------

# Same merge install.sh performs on the Mac: (event, matcher) tuples, deduped
# by (matcher, hook-script-in-command) so re-runs are no-ops, timestamped
# backup first, and a hard refusal on invalid JSON rather than clobbering a
# file we can't parse.
mkdir -p "$HOME/.claude"
SETTINGS="$HOME/.claude/settings.json"
if [ -f "$SETTINGS" ]; then
	BACKUP="$SETTINGS.expediter-bak.$(date +%Y%m%d-%H%M%S)"
	cp "$SETTINGS" "$BACKUP"
	printf '✓ Backed up settings.json → %s\n' "$BACKUP"
fi
if ! python3 - "$SETTINGS" "$HOOK_SCRIPT" <<'PY'
import json, os, sys

settings_path, hook_script = sys.argv[1], sys.argv[2]

# (event_name, matcher) tuples. SessionStart's matcher accepts only single
# exact strings (not regex / pipe-alternation), so it is registered three times
# — once per source value we care about. `compact` is intentionally omitted to
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
            sys.stderr.write("Refusing to overwrite. Fix it manually and re-run install-remote.sh.\n")
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
        # would collapse to one — the first wins and the other two are silently
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
	err "⚠ Failed to merge hooks into ~/.claude/settings.json."
	exit 1
fi

# --- done ---------------------------------------------------------------------

printf '\n✦ Expediter mini-client is ready on this machine.\n\n'
printf 'Reminders:\n'
printf '  - The Mac side needs the reverse-tunnel block in ~/.ssh/config for this\n'
printf '    host (the main installer prompt writes it; re-run ./install.sh there\n'
printf '    if you skipped it).\n'
printf '  - Steady state: ssh in from a local tmux pane and run `claude`. Nothing else.\n'
