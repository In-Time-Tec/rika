# Rika

Rika is a collaborative coding-agent CLI and terminal application. Every Turn runs as a durable execution that survives client and executor restarts. Local execution remains the default, while an explicitly remote Thread runs in an isolated E2B workspace. Hosted identity, access, Threads, and Generalist execution authority live in PostgreSQL.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/In-Time-Tec/rika/main/install.sh | sh
```

Or from npm:

```bash
npm install -g @rikafx/cli
```

Both install the same binaries and give you a `rika` command. The curl installer puts them under
`~/.local/share/rika/current` with a link at `~/.local/bin/rika`; set `RIKA_VERSION`,
`RIKA_INSTALL_ROOT`, or `RIKA_BIN_DIR` to change the version or locations. macOS and Linux on arm64
and x86_64 are supported.

## Setup

Only needed to work on Rika itself.

```bash
bun install
bun run check
bun run dev
```

The standard repository commands are `build`, `check`, `dev`, `format`, `test`, and `typecheck`.

## Configuration

Global settings live at `~/.config/rika/settings.json`. A workspace can override them with `.rika/settings.json`. Model-provider credentials belong to the selected Personal or Organization owner, are encrypted by the API, and are never returned by read APIs. Local, Runner, and Orb execution use that hosted owner; executors never receive model credentials.

```json
{
  "subagents": {
    "maxDepth": 4,
    "maxSubagents": 4
  },
  "keymap": {
    "submit": "enter",
    "newline": "shift+enter"
  }
}
```

```bash
rika auth login
rika provider login codex
# Or configure a hosted API-key provider:
rika credential set openrouter
rika config list
rika doctor
rika
```

Read `PRODUCT.md` for product direction and `CONTEXT.md` for the vocabulary and ownership model.
