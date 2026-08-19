# Rika

Rika is a local coding-agent CLI and terminal application. Every Turn runs as a durable execution that survives restarts, Threads and Turns stay in local SQLite, and the whole session renders in your terminal.

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

## Package and install from source

Build and install an explicit host target:

```bash
bun run package -- --target linux-x64
bun run install-local
rika-dev --version
```

`install-local` installs the existing versioned host archive under `~/.local/share/rika-dev/current` with a command at `~/.local/bin/rika-dev`. A source build is deliberately named `rika-dev` and kept in its own directory so it never overwrites a released `rika` from npm or the installer — the two can be installed side by side. Set `RIKA_PACKAGE_TARGET`, `RIKA_INSTALL_ROOT`, or `RIKA_BIN_DIR` to override the target or locations. `uninstall-local` removes the source build but keeps Rika state and configuration.

## Configuration

Global settings live at `~/.config/rika/settings.json`. A workspace can override them with `.rika/settings.json`. Credentials stay out of JSON: a provider override names the environment variable that supplies its API key. Mode names and routes are configurable, and direct provider/model routes do not require aliases.

```json
{
  "subagents": {
    "maxDepth": 4,
    "maxSubagents": 4
  },
  "providers": {
    "openai": {
      "api": "chat-completions",
      "baseUrl": "http://127.0.0.1:9000/v1",
      "apiKeyEnv": "RIKA_MODEL_API_KEY"
    }
  },
  "defaultMode": "local",
  "modes": {
    "local": {
      "main": { "provider": "openai", "model": "my-local-model", "effort": "medium" }
    }
  }
}
```

```bash
export RIKA_MODEL_API_KEY="your-provider-key"
rika config list
rika doctor
rika
```

Read `PRODUCT.md` for product direction and `CONTEXT.md` for the vocabulary and ownership model.
