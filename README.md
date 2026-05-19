![Expediter banner](docs/assets/expediterv0_banner_260519.webp)

## Install

macOS only for now. The installer is interactive but the happy path is two prompts.

```bash
git clone https://github.com/AsteroidHunter/expediter.git
cd expediter
./install.sh
```

The installer will:

1. Check for [Claude Code](https://docs.claude.com/en/docs/claude-code/setup) and offer to install it if missing.
2. Check for tmux, Homebrew, and Bun, and offer to install whatever's missing in one go. (Homebrew's installer prompts for your Mac password — that's normal and unavoidable.)
3. Build the app (`bun install` + `bun run build`).
4. Drop two commands onto your `PATH` (in `~/.local/bin/`):
   - `expediter` — starts the daemon (if it's not already running) and prints the URL + a scannable QR code for your phone.
   - `claudex` — opens a fresh tmux session with `claude` in one window and `expediter` in another, so you can start a session with one command.
5. Offer to merge Expediter's hook entries into `~/.claude/settings.json` (with a timestamped backup).
6. Offer to apply Expediter's tmux styling via `source-file` in `~/.tmux.conf` (with a backup if you already have one).

## Use

Plug your phone into your Mac with USB Personal Hotspot turned on, then:

```bash
expediter
```

You'll see a URL and a QR code. Scan the QR with your phone's camera and open the link in Safari — it loads as a PWA you can add to your home screen.

To start a new Claude Code session with the daemon already running alongside, use:

```bash
claudex
```

## Uninstall

```bash
rm ~/.local/bin/expediter ~/.local/bin/claudex
rm -rf ~/.config/expediter
```

If you applied the tmux styling, remove the `source-file` line from `~/.tmux.conf` (or restore the timestamped backup the installer made next to it).

If you merged hooks, restore the timestamped backup of `~/.claude/settings.json` the installer made, or remove the matcher blocks whose `command` references `bin/expediter-hook.sh` in your clone.
