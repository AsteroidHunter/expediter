#!/usr/bin/env python3
# codex-hooks-merge.py — register (or remove) Expediter's Codex hooks.
#
# Usage:
#   python3 codex-hooks-merge.py <codex_home> <hook_script>              merge
#   python3 codex-hooks-merge.py <codex_home> <hook_script> --uninstall  splice
#
# Merge mode writes/merges <codex_home>/hooks.json with Expediter's five hook
# events (SessionStart, UserPromptSubmit, PostToolUse, Stop,
# PermissionRequest — the intersection of Claude Code's registration that
# Codex 0.144.1 supports; no matchers) and pre-trusts exactly those hooks by
# writing [hooks.state."<hooks.json>:<event_label>:<group#>:<hook#>"] entries
# with the canonical-JSON SHA-256 trusted_hash into <codex_home>/config.toml.
# Codex then runs the hooks with no review prompt. The trust recipe is
# source-derived at rust-v0.144.1 (command_hook_hash / version_for_toml) and
# was reproduced byte-for-byte against a live harness; a future Codex that
# changes the recipe degrades to its standard review prompt, never breakage.
#
# Key facts the implementation leans on (verified live, codex-compatibility
# plan phase 0/4):
#   - Trust keys carry the CANONICALIZED (realpath) hooks.json path — Codex
#     resolves $CODEX_HOME through symlinks before composing keys.
#   - The hashed identity is the raw hook group as written in hooks.json
#     (env-var substitution happens after hashing): {"event_name": <label>,
#     "hooks": [{"type": "command", "command": <raw>, "timeout": 600,
#     "async": false}]}, recursively key-sorted, compact separators.
#   - Codex stores trust as per-key TOML table headers:
#     [hooks.state."<key>"] / trusted_hash = "sha256:<hex>".
#
# The caller (install.sh / update.sh / uninstall.sh) takes timestamped
# backups of both files BEFORE invoking this script. Idempotent: a re-run
# with unchanged inputs rewrites nothing and reports "0 added".
#
# install-remote.sh embeds a copy of this logic (it is curl'd standalone onto
# the remote box and cannot reference repo files); keep the two in sync.

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


# Split a TOML document into (header_line_or_None, [lines]) segments. The
# leading segment (before any table header) has header None. Conservative
# text-level surgery: only [hooks.state."<key>"] tables Expediter owns are
# ever removed; everything else passes through byte-identical.
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

    # Duplicate-key guard: a key we are about to append must not survive
    # anywhere in the remaining text (e.g. written in a TOML shape this
    # splicer does not model) — a duplicate table is a TOML parse error that
    # would break the user's Codex outright.
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

    # Parse-validate when tomllib is available (python 3.11+). On failure,
    # leave the original file untouched and fail loudly.
    try:
        import tomllib

        tomllib.loads(out)
    except ModuleNotFoundError:
        pass
    except Exception as e:  # tomllib.TOMLDecodeError
        fail(f"internal error: rewritten config.toml would not parse ({e}). Aborting, file untouched.")

    if out != original:
        with open(config_path, "w") as f:
            f.write(out)
    return removed


def main():
    args = [a for a in sys.argv[1:] if a != "--uninstall"]
    uninstall = "--uninstall" in sys.argv[1:]
    if len(args) != 2:
        fail("usage: codex-hooks-merge.py <codex_home> <hook_script> [--uninstall]")
    codex_home, hook_script = args
    os.makedirs(codex_home, exist_ok=True)
    hooks_path = os.path.join(codex_home, "hooks.json")
    # Trust keys must carry the canonical path — Codex realpaths $CODEX_HOME
    # before composing keys (verified: /tmp vs /private/tmp on macOS).
    hooks_path_canonical = os.path.realpath(hooks_path)
    config_path = os.path.join(codex_home, "config.toml")

    data = load_hooks_file(hooks_path)
    hooks = data["hooks"]

    if uninstall:
        # Collect our (event,group) keys from the PRE-splice indices, then drop
        # the groups. If a user's own group sits after ours in the same event,
        # its index shifts down and Codex will re-show its standard review
        # prompt for that hook — loud and benign.
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
        # Update in place (stale repo path after a move) so the group keeps its
        # index and the trust key stays stable. Extra duplicate groups from
        # older registrations collapse to the first.
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

    # Trust entries for every hook that is ours in the merged file, keyed by
    # its actual post-merge indices. Stale versions of the same keys are
    # removed first; user-owned keys never match remove_keys and pass through.
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


if __name__ == "__main__":
    main()
