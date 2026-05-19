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

Make sure your phone and your Mac are on the same Wi-Fi network, then:

```bash
expediter
```

You'll see a QR code in your terminal. Scan it with your phone's camera and open the link in Safari — it loads as a PWA you can add to your home screen.

To start a new Claude Code session with the daemon already running alongside, use:

```bash
claudex
```

### Network requirements

Expediter needs your phone to be able to reach your Mac at its LAN IP. That works on home Wi-Fi and most office or coworking networks. Two situations where it won't work:

- **Wi-Fi networks with client isolation** (some hotel and airport Wi-Fi, guest networks at companies) drop peer-to-peer traffic at the access point. Your phone can't reach your Mac, no matter what the QR says. Fall back to USB Personal Hotspot in this case — plug your phone in, turn the hotspot on, re-run `expediter`, and the launcher will pick the tether IP.
- **Captive portals** intercept HTTP requests until you sign in. Complete the captive-portal sign-on on both devices first, then re-run `expediter`.

If you switch networks (coffee shop to home, e.g.), your Mac gets a new IP and the old QR points at the wrong address. Re-run `expediter` to get a fresh QR.

### Home-screen install

You can "Add to Home Screen" from Safari, but the daemon hands out a fresh session token on every restart (see "Security & access control" below), so you'll re-scan the QR each time you launch from the icon — the standalone window starts with an empty session storage. A future iteration may keep a long-lived per-PWA cookie alongside; for now, treat the home-screen icon as a bookmark that needs a paired QR scan.

## Security & access control

Expediter trusts your local network, like Plex, Sonos, or a Philips Hue bridge. Anyone on the same Wi-Fi can reach the daemon's HTTP port; a per-session token gate stops them from doing anything once they reach it.

The token is 16 cryptographically random bytes, base64url-encoded (~22 characters), held only in the daemon's process memory — there is no token file on disk. The QR you scan encodes the token in the URL fragment (`http://<host>:5179/#<token>`); browsers never transmit URL fragments to servers, so the token stays out of request logs, server access logs, and proxy logs. Your phone's inline page script reads the fragment, stashes it in `sessionStorage`, and immediately clears the address bar.

Every time you stop and restart the daemon (Mac reboot, manual stop+start, crash + relaunch, `expediter` re-invocation), a fresh token is minted in the new process. The old QR stops working; your phone will prompt you to re-scan. There is no rotation ceremony beyond "restart the daemon."

**What this stops:** uninvited devices on the same Wi-Fi (no token, can't reach `/api/*`), borrowed-phone access creep (the token dies when you stop the daemon), and post-session token replay (the new daemon process knows nothing about the old token).

**What this does not stop:** passive packet sniffing on the same network. Expediter speaks plain HTTP, so anyone on the same broadcast domain or upstream link who can capture packets can read your ticket titles, session IDs, project paths, and `cwd` strings. The token itself can also be captured in flight and replayed for the duration of that daemon process. Use Expediter on Wi-Fi you'd put your home automation on, not on shared/untrusted networks. If you need transport encryption for a shared network, that's a future option (local CA + iOS cert install — documented in the plan); for now the v0 posture is HTTP + LAN trust.

The daemon also trusts processes on your own Mac — anything running as your user account can POST hook events without a token (via `127.0.0.1`) and can fetch the current token from a loopback-only `/api/token` endpoint. This is the same trust boundary the operating system already enforces around your home directory, Anthropic API keys, and SSH keys; the token gate's job is to extend that trust selectively to your phone.

### Running the daemon

`expediter` runs the production build (`bun ./build/index.js`) under the hood. SvelteKit's built-in CSRF check is production-only, so the production build is the supported deployment surface. `bun run dev` is for contributors changing the code; don't use it as your everyday daemon.

For the full security rationale and the rejected alternatives (HTTPS local CA, Tailscale, sslip.io, TLS-PSK), see [the token-qr-fragment-auth plan](expediterwiki/plans/token-qr-fragment-auth/token-qr-fragment-auth_moc.md) and [the pre-public-release security recheck](expediterwiki/reasoning_20260518_pre-public-release-security-recheck.md).

## Uninstall

```bash
rm ~/.local/bin/expediter ~/.local/bin/claudex
rm -rf ~/.config/expediter
```

If you applied the tmux styling, remove the `source-file` line from `~/.tmux.conf` (or restore the timestamped backup the installer made next to it).

If you merged hooks, restore the timestamped backup of `~/.claude/settings.json` the installer made, or remove the matcher blocks whose `command` references `bin/expediter-hook.sh` in your clone.
