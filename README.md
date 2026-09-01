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

### Personal Railway stack

`bun run dev:remote` deploys the current Docker worktree to an isolated `rika-dev-*` Railway project. Alchemy
creates private API and web services, private PostgreSQL 17, a Storage Bucket, and the only public service, Caddy.
The service processes use production configuration. Set the external GitHub OAuth, GitHub App, Resend, E2B API
key, and E2B template identity values from `.env.example` before deploying. Set `RAILWAY_WORKSPACE_ID` in the command process so the project cannot land in another workspace. Authenticate
Alchemy's Railway provider with an Alchemy profile or inject `RAILWAY_API_TOKEN` into the command process. Do not
store that provisioning token in `.env`.

```bash
bun run dev:remote
bun run dev:remote:destroy
```

The generated stage identity is retained at `.alchemy/rika-dev-stage` with mode `0600`. Keep it and the matching
`.alchemy/state/Rika/<stage>` state after failed deploys or destroys so Alchemy can retry cleanup. The destroy
command accepts only the generated `dev-<UUIDv4>` identity and refuses production, staging, and `pr-*` stages.
Interrupted deploys reuse that identity and adopt only its random-named project resources. Destroy also requires the
matching Alchemy `Railway.Project` state, so missing state fails closed instead of reporting a false cleanup.

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
