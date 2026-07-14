#!/usr/bin/env bash
# install-remote.sh — set up the Expediter mini-client on a REMOTE box.
#
# Run this ON the remote machine (the one you ssh into and run claude on).
# The normal path: on the Mac run `expediter install remote <host>`, then ssh
# into the box as usual and paste the command it printed:
#
#   curl -fsSL https://raw.githubusercontent.com/AsteroidHunter/expediter/main/install-remote.sh | bash
#
# (Running it from a full clone of the repo works too.)
#
# Flags:
#   --branch <b>   Fetch the hook script from branch <b> instead of main —
#                  the Mac-side command appends this automatically when the
#                  install it came from runs a non-main branch.
#   --uninstall    Reverse the install: splice the expediter hook entries out
#                  of ~/.claude/settings.json (timestamped backup first) and
#                  remove ~/.expediter/. Nothing else on the box is touched.
#
# What it does — everything stays inside YOUR home directory; nothing on the
# (possibly shared) box's system config is touched, and no root is needed:
#   1. Checks for python3 and curl; refuses loudly if either is missing.
#   2. Copies expediter-hook.sh → ~/.expediter/bin/ and marks it executable.
#      When no local copy sits next to this script (the curl|bash path), the
#      hook is fetched from the repo's raw GitHub URL; a failed fetch aborts
#      loudly — no partial installs.
#   3. Merges Expediter's hook entries into ~/.claude/settings.json
#      (timestamped backup first; refuses to touch invalid JSON; re-runs are
#      deduped, never stacked).
#
# How it works afterwards: the hook script detects it is in an ssh session
# (no $TMUX_PANE, $SSH_CONNECTION set) and POSTs each claude event to
# localhost:5179 — which the RemoteForward tunnel, written into the Mac's
# ~/.ssh/config by `expediter install remote <host>`, carries back to the Mac
# daemon. Steady state is zero-friction: `ssh <host>`, run `claude`, tickets
# appear.

set -euo pipefail

err() { printf '%s\n' "$*" >&2; }

# --- 0. flags ------------------------------------------------------------------

BRANCH="main"
UNINSTALL=0
while [ $# -gt 0 ]; do
	case "$1" in
		--branch)
			if [ $# -lt 2 ] || [ -z "$2" ]; then
				err "install-remote.sh: --branch needs a value."
				exit 1
			fi
			BRANCH="$2"
			shift 2
			;;
		--uninstall)
			UNINSTALL=1
			shift
			;;
		*)
			err "install-remote.sh: unknown flag: $1 (supported: --branch <b>, --uninstall)"
			exit 1
			;;
	esac
done

# Raw-content base for the hook fetch. The env override exists so the fetch
# path can be exercised against a local HTTP sink in tests; real runs never
# set it.
RAW_BASE="${EXPEDITER_RAW_BASE:-https://raw.githubusercontent.com/AsteroidHunter/expediter}"

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

# --- 2. uninstall mode ---------------------------------------------------------

# Reverse of the install: splice our hook entries out of settings.json (same
# walk uninstall.sh does on the Mac — drop any matcher block whose command
# references expediter-hook.sh, trim emptied keys), then remove ~/.expediter/.
if [ "$UNINSTALL" = 1 ]; then
	SETTINGS="$HOME/.claude/settings.json"
	if [ -f "$SETTINGS" ] && grep -q "expediter-hook.sh" "$SETTINGS"; then
		BACKUP="$SETTINGS.expediter-uninstall-bak.$(date +%Y%m%d-%H%M%S)"
		cp "$SETTINGS" "$BACKUP"
		printf '✓ Backed up settings.json → %s\n' "$BACKUP"
		if ! python3 - "$SETTINGS" <<'PY'
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
removed = 0
if isinstance(hooks, dict):
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

print(f"Hook blocks removed: {removed}.")
PY
		then
			err ""
			err "⚠ Failed to remove hooks from ~/.claude/settings.json."
			exit 1
		fi
	else
		printf '⊘ No expediter entries in ~/.claude/settings.json (or no settings.json).\n'
	fi
	if [ -d "$HOME/.expediter" ]; then
		rm -rf "$HOME/.expediter"
		printf '✓ Removed ~/.expediter/.\n'
	else
		printf '⊘ ~/.expediter/ already gone.\n'
	fi
	printf '\n✦ Expediter mini-client removed from this machine.\n'
	exit 0
fi

# --- 3. hook script ----------------------------------------------------------

# Locate expediter-hook.sh relative to this script: bin/ sibling when run from
# a repo clone, same directory when the two files sit together. When neither
# exists — the curl|bash path, where "this script" is bash's stdin — fetch the
# hook from the repo's raw URL on the same branch this installer came from.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOOK_SOURCE=""
for candidate in "$SCRIPT_DIR/bin/expediter-hook.sh" "$SCRIPT_DIR/expediter-hook.sh"; do
	if [ -f "$candidate" ]; then
		HOOK_SOURCE="$candidate"
		break
	fi
done
FETCHED=""
if [ -z "$HOOK_SOURCE" ]; then
	HOOK_URL="$RAW_BASE/$BRANCH/bin/expediter-hook.sh"
	FETCHED="$(mktemp)"
	if ! curl -fsSL "$HOOK_URL" -o "$FETCHED" || [ ! -s "$FETCHED" ]; then
		rm -f "$FETCHED"
		err "⚠ Could not fetch expediter-hook.sh from:"
		err "  $HOOK_URL"
		err "  Check that this machine can reach GitHub and re-run."
		exit 1
	fi
	HOOK_SOURCE="$FETCHED"
	printf '✓ Fetched expediter-hook.sh (branch %s)\n' "$BRANCH"
fi

HOOK_DIR="$HOME/.expediter/bin"
HOOK_SCRIPT="$HOOK_DIR/expediter-hook.sh"
mkdir -p "$HOOK_DIR"
cp "$HOOK_SOURCE" "$HOOK_SCRIPT"
chmod +x "$HOOK_SCRIPT"
[ -n "$FETCHED" ] && rm -f "$FETCHED"
printf '✓ Hook script installed at %s\n' "$HOOK_SCRIPT"

# --- 4. hook entries ---------------------------------------------------------

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
printf '    host (`expediter install remote <host>` on the Mac writes it).\n'
printf '  - Steady state: ssh in from a local tmux pane and run `claude`. Nothing else.\n'
