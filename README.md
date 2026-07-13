# Rika

Rika is a local-only durable coding-agent CLI and OpenTUI application built with Effect v4, Effect SQL, Baton, Relay, and OpenTUI.

The implementation is in its specification and dependency-proof phase. See `PLAN.md`, `TODO.md`, and `docs/features/FEATURES.md` for the execution plan and complete feature ledger.

## Boundaries

- Released Baton and Relay packages are the committed dependency contract; local coordinated development uses an explicit non-persistent link overlay, never copied source.

## Local Framework Development

Use sibling checkouts at `../batonfx` and `../relay` while developing framework and Rika changes together:

```bash
bun run upstream:link
bun run upstream:status
```

`upstream:link` builds Relay's public SDK, registers the required public Baton and Relay packages with Bun, links them into Rika without modifying `package.json` or `bun.lock`, and clears Turbo's local cache. Run it again after changing Relay build output.

Restore the pinned registry dependencies before final package verification:

```bash
bun run upstream:registry
```

- Relay owns durable executions and Child Runs.
- Baton owns the agent loop.
- Rika owns local product semantics, tools, extensions, persistence, and TUI behavior.
- Rika does not include Rivet, web, IDE, remote runners, orbs, semantic code search, or ast-grep outline.

## Commands

```bash
bun install
bun run docs:check
bun run deps:check
bun run format:check
bun run lint
bun run typecheck
bun run test
bun run build
```

## Local installation

Keep `rika` as the last promoted local build. This command packages the current working tree for the current host
before installing it, so it cannot silently reinstall a stale executable:

```bash
bun run install:local
rika --version
```

`bun run install:local:existing` installs the existing host archive without rebuilding it. Use that only when you
intentionally want the previously packaged artifact. `bun run package:build` remains available when release work
needs archives for every supported platform.

For recoverable local promotions, commit the working tree and optionally create a local tag before installation:

```bash
git tag local/2026-07-12-description
bun run install:local
```

Git tags point to commits and do not include uncommitted changes.

The defaults are `~/.local/share/rika/current` for the packaged tree and `~/.local/bin/rika` for the command.
Set `RIKA_INSTALL_ROOT` and `RIKA_BIN_DIR` to override them. The installer keeps OpenTUI's native `node_modules`
adjacent to the packaged binary and refuses to replace a command it does not own. Remove only the installed program
and symlink with `bun run uninstall:local`; Rika state and configuration are retained.

If `~/.local/bin` is not already on your shell path, add it once:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

## VibeProxy Gateway configuration

Rika follows Amp's settings layout. Global settings live at `~/.config/rika/settings.json`; a repository may override
them with `.rika/settings.json`. Gateway names are arbitrary. To route medium mode through VibeProxy, use:

```json
{
  "gateways": {
    "openai": {
      "protocol": "openai",
      "baseUrl": "http://127.0.0.1:8317/v1",
      "auth": { "type": "bearer-env", "variable": "RIKA_MODEL_API_KEY" }
    }
  },
  "models": {
    "subscription": {
      "gateway": "openai",
      "candidates": ["your-vibe-model-id"],
      "compaction": { "contextWindow": 372000, "reserveTokens": 128000, "keepRecentTokens": 32000 },
      "variants": {
        "medium": {
          "normal": { "options": { "reasoning": { "effort": "medium" }, "max_output_tokens": 128000 } },
          "fast": {
            "options": { "reasoning": { "effort": "medium" }, "max_output_tokens": 128000, "service_tier": "priority" }
          }
        },
        "high": { "normal": { "options": { "reasoning": { "effort": "high" }, "max_output_tokens": 128000 } } }
      }
    }
  },
  "modes": {
    "medium": {
      "budget": 64,
      "main": { "alias": "subscription", "effort": "medium" },
      "oracle": { "alias": "subscription", "effort": "high" }
    }
  }
}
```

Keep gateway credentials out of JSON. Each `bearer-env` Gateway names the environment variable resolved once at startup. The defaults use `OPENAI_API_KEY` and `ANTHROPIC_API_KEY`; VibeProxy configurations may name `RIKA_MODEL_API_KEY` on both protocol Gateways:

```bash
export RIKA_MODEL_API_KEY="your-vibe-proxy-key"
rika config list
rika doctor
rika
```

The installed `rika` command and the OpenTUI session use the same resolved settings, durable Relay database, and Baton
model registration. Workspace settings override global settings without copying credentials into the repository.
Automatic titles reuse the initiating turn's configured mode route and do not require credentials for another provider.
