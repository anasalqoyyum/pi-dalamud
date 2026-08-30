# Pi Chat for FFXIV

Pi Chat adds a small, dedicated in-game window for talking to a local Pi coding agent. It has two pieces:

- a Dalamud plugin that provides the window and `/pi` commands;
- a local helper that runs Pi and keeps the connection private.

The full conversation stays in the Pi Chat window. FFXIV chat only receives short local notices.

This is a private, experimental project. Third-party tools may not be allowed by Square Enix or the FFXIV service terms. Use it at your own risk.

## What it supports

```text
/pi             Open the Pi Chat window
/pi <prompt>    Send a prompt
/pi stop        Stop the current request
/pi status      Show the connection status
/pi new         Start a fresh session
```

The bridge listens only on your computer (`127.0.0.1`). It does not read game chat, send Pi's responses to game chat servers, automate gameplay, or let the plugin choose arbitrary workspaces.

The chat window exposes two fixed model presets: `openai-codex/gpt-5.6-luna` with `max` thinking and `openai-codex/gpt-5.6-sol` with `high` thinking. After selecting a model, the thinking picker shows only levels reported by Pi; `Off` is available when supported.

## What you need

- FFXIV with XIVLauncher and Dalamud.
- Node.js 22.19 or newer and pnpm 10.26.1.
- Pi 0.84.4, signed in with `/login` and available as `pi` on your `PATH`.
- The .NET SDK 10.0.400 if you are building the plugin.

## Quick start

Install the project dependencies and Pi:

```bash
corepack enable
pnpm install --frozen-lockfile
npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.84.4
```

Run `pi`, use `/login`, and select a provider. Then build and start the local helper with a dedicated workspace:

```bash
pnpm build:bridge
mkdir -p "$HOME/pi-workspaces/ffxiv-chat"
PI_DALAMUD_WORKSPACE="$HOME/pi-workspaces/ffxiv-chat" pnpm --dir src/bridge start
```

On its first start, the helper creates a pairing token in `~/.config/pi-dalamud/bridge.json`. Keep that token private.

Build the plugin:

```bash
pnpm build:plugin
```

In XIVLauncher, add the resulting `PiDalamud.Plugin.dll` under **Experimental → Dev Plugin Locations**, enable **Pi Chat** under **Dev Tools**, then open `/pi`. In **Settings**, use the default URL `ws://127.0.0.1:32145`, paste the pairing token, and choose **Save and reconnect**.

If Pi and the helper run in WSL while FFXIV runs on Windows, use WSL mirrored networking so both sides can use `127.0.0.1`. The detailed setup and firewall guidance is in [`SPEC.md`](SPEC.md).

## Checks for contributors

```bash
pnpm test
pnpm lint
```

The bridge and plugin have separate test suites, so you can also run `pnpm test:bridge` or `pnpm test:plugin` while working on one side.

More detailed design and troubleshooting information lives in [`SPEC.md`](SPEC.md), [`docs/protocol-v1.md`](docs/protocol-v1.md), and [`docs/failure-isolation.md`](docs/failure-isolation.md).
