# Rika

Rika is a local coding-agent CLI and terminal application. It uses Baton for the agent loop, Relay for durable execution, Effect SQL for local product state, and OpenTUI for rendering.

## Setup

```bash
bun install
bun run check
bun run dev
```

The normal repository commands are `build`, `check`, `dev`, `format`, `test`, and `typecheck`.

## Package and install

Build the current host package, or pass an explicit target:

```bash
bun run package
bun run package -- --target linux-x64
bun run install-local
rika --version
```

`install-local` restores the pinned registry dependencies, packages the current working tree, and installs it under `~/.local/share/rika/current` with a command at `~/.local/bin/rika`. Set `RIKA_INSTALL_ROOT` or `RIKA_BIN_DIR` to override those locations. `uninstall-local` removes the installed program but keeps Rika state and configuration.

## Configuration

Global settings live at `~/.config/rika/settings.json`. A workspace can override them with `.rika/settings.json`. Credentials stay out of JSON: a provider override names the environment variable that supplies its API key.

```json
{
  "providers": {
    "openai": {
      "baseUrl": "http://127.0.0.1:9000/v1",
      "apiKeyEnv": "RIKA_MODEL_API_KEY"
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
