![Expediter banner](docs/assets/expediterv0_banner_260519.webp)

Expediter is a companion app that minimizes the amount of time and friction it takes to switch between many active agent sessions, thereby enabling you to increase your throughput and steer more coding agents. When you are planning a spec with an agent that spends two minutes thinking while your third agent is awaiting a response while your fifth agent is requesting permission to delete a branch under active development, it should take you seconds to course correct your agents. Expediter makes this trivial!

## Why

Software engineering in languages with abundant training data is an increasingly a low touch job. The *software architect* of today is more like the chef who manages a bunch of line cooks. Coding agents are incredible at cooking ... their work done per unit time is magnitudes higher than that of humans. This makes agent-minutes extremely valuable. An agent stuck on a request or veering onto an unproductive path is costly, especially when executing a long spec because each delay piles up. If we want to optimally increase our throughput while retaining varying but non-zero levels of oversight over a fleet of agents, it makes sense to minimize the amount of time it takes to switch from one agent to another. Even if you aren't optimizing but simply babysitting many agents, it is beneficial to have a simple tool that makes it easy to access any of your agent sessions.

I hope that the expediter helps you manage more agents or manage few of them better by putting you in a loop with them. I have been using it and **it has helped eliminate the time it takes hopping from agent number one to five to three to four** (I am also someone who always has too many tabs and windows open) + **enabled me to manage more agents than I otherwise would have**.

I don't know if this is the optimal shape for a multi-agent manager, so at the moment, I want to see if the core UX resonates with others. Give it a go and share what you think of it!

(Needless to say, I built this because I was unhappy with all the existing agent management interfaces. Claude Code's official remote control feature demands telemetry. The open-source spin-offs are fine but they also try to be a terminal on your phone, which serves a purpose, but not the problem I was facing.

The human-in-the-loop does impose some inherent constraints; there are some who expect humans will be RL-ified from software engineering altogether. Even if that comes to pass, there will still be those who would exercise their agency, orchestrate many talking machines, and find value in building.)

![Expediter simple visual guide](docs/assets/expediter_visual_guide.webp)

## Install

macOS only for now. The installer is interactive but the happy path is two prompts.

```bash
git clone https://github.com/AsteroidHunter/expediter.git
cd expediter
./install.sh
```

<details>
<summary>The installer will ...</summary>

1. Check for [Claude Code](https://docs.claude.com/en/docs/claude-code/setup) and offer to install it if missing.
2. Check for tmux, Homebrew, and Bun, and offer to install whatever's missing in one go. (Homebrew's installer prompts for your Mac password -- that's normal and unavoidable.)
3. Build the app (`bun install` + `bun run build`).
4. Write `~/.config/expediter/config` so the shims can find your clone (`EXPEDITER_HOME` points at the repo path).
5. Drop two commands into `~/.local/bin/`, and add that directory to `~/.zshrc` if it isn't already on your `PATH`:
   - `expediter` -- starts the daemon (if it's not already running) and prints the URL + a scannable QR code for your phone.
   - `claudex` -- opens a fresh tmux session with `claude` and `expediter` in side-by-side panes, so you can start a session with one command.
6. Offer to merge Expediter's hook entries into `~/.claude/settings.json` (with a timestamped backup).
7. Offer to apply Expediter's tmux styling via `source-file` in `~/.tmux.conf` (with a backup if you already have one).

</details>

## How to use

First, make sure your phone and your Mac are on the same Wi-Fi network.

If you're an opinionated tmux user, just run:

```bash
expediter
```

A QR code shows up in your terminal. Scan it with your phone's camera, open the link in Safari, and you're connected.

However, there's another command if you want to start a fresh Claude Code session along with the Expediter daemon:

```bash
claudex
```

That opens a tmux session with `claude` and `expediter` in side-by-side panes.

If you're new to tmux or Claude Code, try:

```bash
claudex uno
```

That starts the daemon, prints the QR, and walks you through four numbered onboarding steps below it.

### Network requirements

Expediter needs your phone to reach your Mac at its LAN IP. That's fine on home Wi-Fi and most office or coworking networks. Two situations where it won't work:

- **Wi-Fi with client isolation.** Some hotel and airport Wi-Fi, and some company guest networks, block peer-to-peer traffic at the access point. Your phone can't reach your Mac no matter what the QR says.
- **Captive portals.** HTTP requests get intercepted until you sign in. Complete the sign-on on both devices first, then re-run `expediter`.

If you switch networks (say, coffee shop to home), your Mac gets a new IP and the old QR points at the wrong address. Re-run `expediter` to get a fresh one.

## Security & access control

Expediter trusts your local network, like Plex, Sonos, or a Philips Hue bridge. Anyone on the same Wi-Fi can reach the daemon's HTTP port; a per-session token gate stops them from doing anything once they reach it.

The token is 16 cryptographically random bytes, base64url-encoded (~22 characters), held only in the daemon's process memory -- there is no token file on disk. The QR you scan encodes the token in the URL fragment (`http://<host>:5179/#<token>`); browsers never transmit URL fragments to servers, so the token stays out of request logs, server access logs, and proxy logs. Your phone's inline page script reads the fragment, stashes it in `sessionStorage`, and immediately clears the address bar.

Every time you stop and restart the daemon (Mac reboot, manual stop+start, crash + relaunch, `expediter` re-invocation), a fresh token is minted in the new process. The old QR stops working; your phone will prompt you to re-scan. There is no rotation ceremony beyond "restart the daemon."

**What this stops:** uninvited devices on the same Wi-Fi (no token, can't reach `/api/*`), borrowed-phone access creep (the token dies when you stop the daemon), and post-session token replay (the new daemon process knows nothing about the old token).

**What this does not stop:** packet sniffing on the same network. Expediter sends ticket data over plain HTTP, so a packet sniffer on your Wi-Fi could read it. With a captured token they could also briefly pop your Terminal window forward, until the daemon restarts and mints a new one. Stick to trusted Wi-Fi; full transport encryption is on the roadmap.

The daemon also trusts processes on your own Mac -- anything running as your user account can POST hook events without a token (via `127.0.0.1`) and can fetch the current token from a loopback-only `/api/token` endpoint. This is the same trust boundary the operating system already enforces around your home directory, Anthropic API keys, and SSH keys; the token gate's job is to extend that trust selectively to your phone.

### Running the daemon

`expediter` runs the production build (`bun ./build/index.js`) under the hood. SvelteKit's built-in CSRF check is production-only, so the production build is the supported deployment surface. `bun run dev` is for contributors changing the code; don't use it as your everyday daemon.

## Uninstall

```bash
./uninstall.sh
```

<details>
<summary>The uninstaller will ...</summary>

1. Check that the daemon isn't running (abort if it is, so it doesn't leave an orphaned `bun` process).
2. Ask for one top-level confirmation.
3. Remove `~/.local/bin/expediter` and `~/.local/bin/claudex`.
4. Remove `~/.config/expediter/config` (and the parent directory if it ends up empty).
5. Splice Expediter's hook entries out of `~/.claude/settings.json` (timestamped backup first).
6. Splice the `source-file` line for `expediter.tmux.conf` out of `~/.tmux.conf` (timestamped backup first; deletes the file if it ends up empty).
7. Remove `~/.expediter-install.log`.

It does NOT touch the cloned repo, Claude Code, Homebrew, tmux, Bun, your `PATH`, or any install-time backups.

</details>
