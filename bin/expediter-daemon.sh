#!/usr/bin/env bash
# expediter-daemon.sh — entrypoint invoked by the LaunchAgent plist.
# Loads ANTHROPIC_API_KEY (and any other overrides) from `~/.expediter/env`
# without ever staging the key into version control, then execs the built
# adapter-node server under Bun.

set -eu

# Load user-local env if present. Format: one `KEY=value` per line.
ENV_FILE="${HOME}/.expediter/env"
if [ -f "$ENV_FILE" ]; then
	set -a
	# shellcheck disable=SC1090
	. "$ENV_FILE"
	set +a
fi

# Defaults; can be overridden in ~/.expediter/env
export EXPEDITER_HOST="${EXPEDITER_HOST:-0.0.0.0}"
export EXPEDITER_PORT="${EXPEDITER_PORT:-5179}"
export EXPEDITER_TRANSCRIPT_ROOT="${EXPEDITER_TRANSCRIPT_ROOT:-${HOME}/.claude}"

REPO_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

# Prefer bun on PATH; fall back to common install locations LaunchAgents won't
# normally see (they only get the system PATH unless we extend it ourselves).
BUN_BIN="${BUN_BIN:-}"
if [ -z "$BUN_BIN" ]; then
	if command -v bun >/dev/null 2>&1; then
		BUN_BIN="$(command -v bun)"
	elif [ -x "${HOME}/.bun/bin/bun" ]; then
		BUN_BIN="${HOME}/.bun/bin/bun"
	elif [ -x "/opt/homebrew/bin/bun" ]; then
		BUN_BIN="/opt/homebrew/bin/bun"
	elif [ -x "/usr/local/bin/bun" ]; then
		BUN_BIN="/usr/local/bin/bun"
	else
		echo "expediter-daemon: bun not found on PATH or in known install paths" >&2
		exit 127
	fi
fi

exec "$BUN_BIN" ./build/index.js
