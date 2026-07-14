#!/usr/bin/env bash
# install-remote.sh — set up the Expediter mini-client on a REMOTE box.
#
# Run this ON the remote machine (the one you ssh into and run claude or
# codex on). The normal path: on the Mac run `expediter install remote
# <host>`, then ssh into the box as usual and paste the command it printed:
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
#                  of ~/.claude/settings.json and $CODEX_HOME/hooks.json
#                  (plus their hooks.state trust entries in config.toml;
#                  timestamped backups first) and remove ~/.expediter/.
#                  Nothing else on the box is touched.
#
# What it does — everything stays inside YOUR home directory; nothing on the
# (possibly shared) box's system config is touched, and no root is needed:
#   1. Checks for python3 (with the stdlib sqlite3 module — the codex title
#      read needs it) and curl; refuses loudly if either is missing.
#   2. Requires at least one of claude code / codex on the box, and wires
#      EVERY harness it finds — promptless (curl|bash consumes stdin, and a
#      mini-client install means "show me tickets for whatever runs here").
#      Re-run this one-liner after installing a new harness to wire it too.
#   3. Copies expediter-hook.sh → ~/.expediter/bin/ and marks it executable.
#      When no local copy sits next to this script (the curl|bash path), the
#      hook is fetched from the repo's raw GitHub URL; a failed fetch aborts
#      loudly — no partial installs.
#   4. claude: merges Expediter's hook entries into ~/.claude/settings.json
#      (timestamped backup first; refuses to touch invalid JSON; re-runs are
#      deduped, never stacked).
#   5. codex: merges the five-event registration into $CODEX_HOME/hooks.json
#      and pre-trusts exactly those hooks via [hooks.state] entries in
#      $CODEX_HOME/config.toml (same recipe the Mac installer uses — see
#      bin/codex-hooks-merge.py, of which this embeds a copy; keys carry THIS
#      box's hooks.json path, computed here at install time).
#
# How it works afterwards: the hook script detects it is in an ssh session
# (no $TMUX_PANE, $SSH_CONNECTION set) and POSTs each agent event to
# localhost:5179 — which the RemoteForward tunnel, written into the Mac's
# ~/.ssh/config by `expediter install remote <host>`, carries back to the Mac
# daemon. Steady state is zero-friction: `ssh <host>`, run `claude` or
# `codex`, tickets appear.

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

# codex_hooks_merge <codex_home> <hook_script> <merge|uninstall>
# Embedded copy of the Mac repo's bin/codex-hooks-merge.py (this script is
# curl'd standalone onto the box, so it cannot reference repo files) — keep
# the two in sync. Merge mode writes/merges <codex_home>/hooks.json with the
# five-event registration and pre-trusts exactly those hooks via
# [hooks.state."<hooks.json>:<label>:<group#>:<hook#>"] trusted_hash entries
# in <codex_home>/config.toml (canonical-JSON SHA-256, keys carry THIS box's
# realpath'd hooks.json). Uninstall mode splices our groups and their trust
# entries back out. The caller takes timestamped backups first.
codex_hooks_merge() {
	python3 - "$1" "$2" "${3:-merge}" <<'PY'
import hashlib
import json
import os
import re
import sys

EVENTS = [
    ("SessionStart", "session_start"),
    ("UserPromptSubmit", "user_prompt_submit"),
    ("PostToolUse", "post_tool_use"),
    ("Stop", "stop"),
    ("PermissionRequest", "permission_request"),
]
MARKER = "expediter-hook.sh"


def fail(msg):
    sys.stderr.write(msg.rstrip() + "\n")
    sys.exit(1)


def hook_hash(event_label, command):
    identity = {
        "event_name": event_label,
        "hooks": [
            {"type": "command", "command": command, "timeout": 600, "async": False}
        ],
    }
    canonical = json.dumps(identity, sort_keys=True, separators=(",", ":"))
    return "sha256:" + hashlib.sha256(canonical.encode()).hexdigest()


def load_hooks_file(path):
    if not os.path.exists(path):
        return {"hooks": {}}
    with open(path) as f:
        try:
            data = json.load(f)
        except json.JSONDecodeError as e:
            fail(
                f"hooks.json is not valid JSON: {e}\n"
                "Refusing to overwrite. Fix it manually and re-run."
            )
    if not isinstance(data, dict):
        fail("hooks.json top-level must be an object. Refusing to overwrite.")
    hooks = data.setdefault("hooks", {})
    if not isinstance(hooks, dict):
        fail("hooks.json 'hooks' must be an object. Refusing to overwrite.")
    return data


def group_is_ours(group):
    if not isinstance(group, dict):
        return False
    for h in group.get("hooks") or []:
        if isinstance(h, dict) and MARKER in str(h.get("command", "")):
            return True
    return False


def toml_segments(text):
    segments = []
    current_header = None
    current_lines = []
    for line in text.split("\n"):
        if re.match(r"^\s*\[", line):
            segments.append((current_header, current_lines))
            current_header = line
            current_lines = []
        else:
            current_lines.append(line)
    segments.append((current_header, current_lines))
    return segments


def state_key_of(header_line):
    if header_line is None:
        return None
    m = re.match(r'^\s*\[hooks\.state\."(.+)"\]\s*$', header_line)
    return m.group(1) if m else None


def rewrite_config_toml(config_path, remove_keys, append_entries):
    try:
        with open(config_path) as f:
            original = f.read()
    except FileNotFoundError:
        original = ""

    segments = toml_segments(original)
    kept = []
    removed = 0
    for header, lines in segments:
        key = state_key_of(header)
        if key is not None and key in remove_keys:
            removed += 1
            continue
        kept.append((header, lines))

    out_parts = []
    for header, lines in kept:
        if header is not None:
            out_parts.append(header)
        out_parts.extend(lines)
    out = "\n".join(out_parts)

    for key, _ in append_entries:
        if f'"{key}"' in out:
            fail(
                f"config.toml already defines hooks.state entry {key} in an "
                "unrecognized format. Refusing to append a duplicate — remove "
                "it manually (or via /hooks inside codex) and re-run."
            )

    if append_entries:
        block_lines = []
        if out.strip():
            block_lines.append("")
        for key, digest in append_entries:
            block_lines.append(f'[hooks.state."{key}"]')
            block_lines.append(f'trusted_hash = "{digest}"')
        out = out.rstrip("\n")
        out = (out + "\n" if out else "") + "\n".join(block_lines) + "\n"
    elif removed:
        out = out.rstrip("\n") + "\n" if out.strip() else ""

    try:
        import tomllib

        tomllib.loads(out)
    except ModuleNotFoundError:
        pass
    except Exception as e:
        fail(f"internal error: rewritten config.toml would not parse ({e}). Aborting, file untouched.")

    if out != original:
        with open(config_path, "w") as f:
            f.write(out)
    return removed


def main():
    codex_home, hook_script, mode = sys.argv[1], sys.argv[2], sys.argv[3]
    uninstall = mode == "uninstall"
    os.makedirs(codex_home, exist_ok=True)
    hooks_path = os.path.join(codex_home, "hooks.json")
    hooks_path_canonical = os.path.realpath(hooks_path)
    config_path = os.path.join(codex_home, "config.toml")

    data = load_hooks_file(hooks_path)
    hooks = data["hooks"]

    if uninstall:
        remove_keys = set()
        removed_groups = 0
        for event, label in EVENTS:
            blocks = hooks.get(event)
            if not isinstance(blocks, list):
                continue
            kept = []
            for g, group in enumerate(blocks):
                if group_is_ours(group):
                    for h in range(len(group.get("hooks") or [])):
                        remove_keys.add(f"{hooks_path_canonical}:{label}:{g}:{h}")
                    removed_groups += 1
                else:
                    kept.append(group)
            if kept:
                hooks[event] = kept
            elif event in hooks:
                del hooks[event]

        if removed_groups and os.path.exists(hooks_path):
            with open(hooks_path, "w") as f:
                json.dump(data, f, indent=2)
                f.write("\n")
        removed_trust = rewrite_config_toml(config_path, remove_keys, []) if os.path.exists(config_path) else 0
        print(f"Codex hooks removed: {removed_groups} group(s), {removed_trust} trust entr(y/ies).")
        return

    added = 0
    updated = 0
    unchanged = 0
    for event, _label in EVENTS:
        desired = f"{hook_script} {event}"
        blocks = hooks.setdefault(event, [])
        if not isinstance(blocks, list):
            fail(f"hooks.json hooks.{event} must be a list. Refusing to overwrite.")
        ours = [g for g in blocks if group_is_ours(g)]
        if not ours:
            blocks.append({"hooks": [{"type": "command", "command": desired}]})
            added += 1
            continue
        first = ours[0]
        current = str((first.get("hooks") or [{}])[0].get("command", ""))
        if current == desired and len(ours) == 1 and len(first.get("hooks") or []) == 1:
            unchanged += 1
            continue
        first["hooks"] = [{"type": "command", "command": desired}]
        for extra in ours[1:]:
            blocks.remove(extra)
        updated += 1

    with open(hooks_path, "w") as f:
        json.dump(data, f, indent=2)
        f.write("\n")

    remove_keys = set()
    append_entries = []
    for event, label in EVENTS:
        blocks = hooks.get(event) or []
        for g, group in enumerate(blocks):
            if not group_is_ours(group):
                continue
            for h, hook in enumerate(group.get("hooks") or []):
                key = f"{hooks_path_canonical}:{label}:{g}:{h}"
                remove_keys.add(key)
                append_entries.append((key, hook_hash(label, str(hook.get("command", "")))))

    rewrite_config_toml(config_path, remove_keys, append_entries)
    print(
        f"Codex hooks merged: {added} added, {updated} updated, {unchanged} unchanged; "
        f"{len(append_entries)} trust entr(y/ies) written."
    )


main()
PY
}

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
# Some minimal distros strip sqlite3 out of the python stdlib. The remote
# codex title read depends on it, so refuse loudly up front rather than
# shipping titleless codex tickets that look like a daemon bug.
if ! python3 -c "import sqlite3" >/dev/null 2>&1; then
	err "⚠ This machine's python3 is missing the stdlib sqlite3 module (some minimal"
	err "  distros strip it). Install the python3-sqlite (or python3-stdlib-extensions)"
	err "  package for your distro and re-run this script."
	exit 1
fi

# The mini-client is only useful if an agent runs here. Wire every harness
# found — promptless by design: curl|bash consumes stdin, and installing the
# mini-client on a box is asking for tickets from whatever runs on it.
HAVE_CLAUDE=0
HAVE_CODEX=0
command -v claude >/dev/null 2>&1 && HAVE_CLAUDE=1
command -v codex >/dev/null 2>&1 && HAVE_CODEX=1
if [ "$UNINSTALL" = 0 ] && [ "$HAVE_CLAUDE" = 0 ] && [ "$HAVE_CODEX" = 0 ]; then
	err "⚠ Neither claude code nor codex is installed on this machine — the"
	err "  mini-client would have nothing to report. Install one and re-run:"
	err "    https://docs.claude.com/en/docs/claude-code/setup"
	err "    https://developers.openai.com/codex/cli"
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
	# Codex side: splice our groups out of hooks.json and delete their
	# hooks.state trust entries from config.toml (backups first). Gated on
	# file contents, not on the codex binary — clean up even if codex itself
	# was removed since the install.
	CODEX_DIR="${CODEX_HOME:-$HOME/.codex}"
	if [ -f "$CODEX_DIR/hooks.json" ] && grep -q "expediter-hook.sh" "$CODEX_DIR/hooks.json"; then
		STAMP="$(date +%Y%m%d-%H%M%S)"
		cp "$CODEX_DIR/hooks.json" "$CODEX_DIR/hooks.json.expediter-uninstall-bak.$STAMP"
		printf '✓ Backed up hooks.json → %s\n' "$CODEX_DIR/hooks.json.expediter-uninstall-bak.$STAMP"
		if [ -f "$CODEX_DIR/config.toml" ]; then
			cp "$CODEX_DIR/config.toml" "$CODEX_DIR/config.toml.expediter-uninstall-bak.$STAMP"
		fi
		if ! codex_hooks_merge "$CODEX_DIR" "$HOME/.expediter/bin/expediter-hook.sh" uninstall; then
			err ""
			err "⚠ Failed to remove codex hooks from $CODEX_DIR/hooks.json."
			exit 1
		fi
	else
		printf '⊘ No expediter entries in codex hooks.json (or no hooks.json).\n'
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
# file we can't parse. Only for harnesses actually on the box.
if [ "$HAVE_CLAUDE" = 1 ]; then
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
fi

# Codex: same writer the Mac installer uses (embedded above). Registers the
# five-event hooks.json and pre-trusts them via hooks.state entries keyed by
# THIS box's hooks.json path, so codex fires them with no review prompt.
if [ "$HAVE_CODEX" = 1 ]; then
	CODEX_DIR="${CODEX_HOME:-$HOME/.codex}"
	STAMP="$(date +%Y%m%d-%H%M%S)"
	if [ -f "$CODEX_DIR/hooks.json" ]; then
		cp "$CODEX_DIR/hooks.json" "$CODEX_DIR/hooks.json.expediter-bak.$STAMP"
		printf '✓ Backed up hooks.json → %s\n' "$CODEX_DIR/hooks.json.expediter-bak.$STAMP"
	fi
	if [ -f "$CODEX_DIR/config.toml" ]; then
		cp "$CODEX_DIR/config.toml" "$CODEX_DIR/config.toml.expediter-bak.$STAMP"
	fi
	if ! codex_hooks_merge "$CODEX_DIR" "$HOOK_SCRIPT" merge; then
		err ""
		err "⚠ Failed to merge hooks into $CODEX_DIR/hooks.json."
		exit 1
	fi
	printf '✓ Codex hooks registered and marked trusted (hooks.state in %s/config.toml);\n' "$CODEX_DIR"
	printf '  review anytime with /hooks inside codex.\n'
fi

# --- done ---------------------------------------------------------------------

printf '\n✦ Expediter mini-client is ready on this machine.\n\n'
printf 'Reminders:\n'
printf '  - The Mac side needs the reverse-tunnel block in ~/.ssh/config for this\n'
printf '    host (`expediter install remote <host>` on the Mac writes it).\n'
printf '  - Steady state: ssh in from a local tmux pane and run `claude` (or `codex`).\n'
printf '    Nothing else.\n'
