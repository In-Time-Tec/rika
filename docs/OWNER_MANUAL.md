# Rika Owner Manual

Rika is an Effect-native coding agent for local and remote software workspaces. It is intentionally Amp-like at the product surface while keeping the internals simple: Effect services/layers, Bun, Turbo, Drizzle, Rivet actors, typed schemas, and replaceable adapters.

## Install and update

For source installs:

```bash
git clone https://github.com/dallenpyrah/rika.git
cd rika
bun install
bun run package:smoke
bun run install:local
```

`install:local` compiles the CLI and copies it to `${RIKA_INSTALL_DIR:-$HOME/.local/bin}/rika`. Put that directory on `PATH`.

Update from source with:

```bash
git pull --ff-only
bun install
bun run update:local
```

For launch builds, `bun run package` writes the compiled artifact and manifest under `dist/release/`.

## Get started

```bash
rika doctor
rika
rika --execute "summarize this repo" --mode smart
```

`rika doctor` prints local diagnostics as JSON and does not upload telemetry.

## Agent modes

Rika ships three mode names as routing data:

| Mode    | Intent                         | Default reasoning | Tool policy  |
| ------- | ------------------------------ | ----------------- | ------------ |
| `rush`  | Lowest latency for small tasks | `none`            | `minimal`    |
| `smart` | Strong default intelligence    | `max`             | `standard`   |
| `deep1` | Capable coding mode            | `medium`          | `autonomous` |
| `deep2` | Deeper coding mode             | `high`            | `autonomous` |
| `deep3` | Maximum coding mode            | `xhigh`           | `autonomous` |

Rika uses Effect AI provider packages for model access. Smart mode routes to Anthropic, and rush/deep1/deep2/deep3 modes route to OpenAI. Rika does not hand-roll provider HTTP/SSE adapters.

## Prompting

- Use one thread per task.
- Be direct: “implement X” beats “can you maybe do X”.
- Mention files, tests, commands, or constraints when you know them.
- Say “do not edit files” when you only want research or planning.
- Put durable repo rules in `AGENTS.md` instead of repeating them in every prompt.

## AGENTS.md guidance

Rika resolves guidance from `AGENTS.md` files in the workspace/root chain and relevant subtrees. Guidance is treated as resolved context, not as a hidden source of authority over system/developer policy.

Use `AGENTS.md` for:

- repo layout and ownership boundaries
- build/test commands
- coding conventions
- common mistakes and review steps

Use `CONTEXT.md` for domain vocabulary, not operational instructions.

## Threads

Threads are durable task ledgers. Current thread commands:

```bash
rika threads list
rika threads search "auth race"
rika threads archive <thread-id>
rika threads unarchive <thread-id>
rika threads share <thread-id>
rika threads reference <thread-id> [query]
```

Interactive slash commands mirror the core lifecycle: `/threads`, `/search`, `/thread`, `/new`, `/archive`, `/unarchive`, `/share`, and `/reference`.

## Files, images, and context

The context resolver supports AGENTS guidance, file mentions, image references, thread references, IDE context, and skill instructions. Resolved context is persisted as thread events and rendered as untrusted context for replay/debugging.

## Tools

Built-in tools are registered through the Effect `ToolRegistry` / `ToolExecutor` boundary and pass through permission policy. Defaults include:

- shell command execution
- fff-backed file/path/content search
- hashline read/edit/write tools with stale-anchor rejection
- semantic search and file-history mode
- ast-grep outline
- MCP tools after discovery/filtering/approval
- specialty tools: Oracle, Librarian, and Painter-like adapters

Rika matches Amp's fast local default: tool permission mode is `allow-all`, so tools run without approval prompts unless you opt into stricter policy or install a plugin with a `tool.call` hook. All built-in, plugin, MCP, specialty, and self-extension tools still enter through `ToolExecutor.Service` and one `PermissionPolicy.Service` decision before execution.

Optional guard configuration is environment based for now:

```bash
RIKA_GUARDED_TOOLS="shell.*,write" rika run "inspect without mutating"
RIKA_GUARDED_FILES="secrets/*,.env" rika
```

Guarded calls return a normal permission tool result and the agent continues. Run `rika doctor` to see the active permission mode; it reports whether guards are configured without printing full tool inputs or secrets.

## Subagents and skills

Subagents run isolated bounded tasks and return compact summaries. Skills are task-specific instruction packages discovered from project/user locations and loaded explicitly.

CLI skill commands:

```bash
rika skills list
rika skills inspect <name>
```

## Code review

Run local review with:

```bash
rika review --staged
rika review --base main packages/agent/src
```

Review checks live in `.agents/checks/` and are executed through read-only subagent boundaries by default.

## MCP

MCP servers are external tool providers. Workspace command servers require explicit approval by server name plus config fingerprint:

```bash
rika mcp list
rika mcp approve <server-name>
```

MCP tools still pass through normal tool policy; MCP is not a permission bypass.

## Plugins and self-extension

Plugins are trusted local TypeScript modules for the MVP. They can register tools, commands, modes, subagents, UI calls, and policy hooks through `@rika/plugin`.

Self-extension commands write auditable workspace files and trust artifacts:

```bash
rika extensions create-skill deploy-helper --description "Deploy safely"
rika extensions create-plugin notify --description "Notify on completion"
rika extensions enable-plugin notify --verification "bun test"
rika extensions disable-plugin notify --reason "not needed"
rika extensions rollback-plugin notify --reason "startup failed"
```

Generated plugins are disabled first and require explicit verification before enablement.

## Interactive CLI and key behavior

`rika` starts the interactive terminal UI. It renders Amp-like chrome with collapsed cards by default, spinner/activity state, mode/cost area, and workspace path. Current MVP input is line-oriented; command palette behavior is exposed through slash commands such as `/help`, `/mode`, `/skills`, and `/review`.

Interactive sessions are thin clients by default. The first TUI for a workspace starts one shared local backend under the workspace data directory; additional TUI windows reuse that backend through the SDK instead of composing another agent/server/tool runtime. Use `rika doctor` to inspect backend status. Use `--ephemeral` when you intentionally want an isolated in-process TUI session for testing.

## Non-interactive and streaming JSON

Use non-interactive mode for scripts and CI:

```bash
rika run --mode rush "write a short summary"
rika --execute --workspace /repo --thread thread_123 "continue the task"
```

Stdout is newline-delimited protocol events. Diagnostics go to stderr.

## Remote control, IDEs, and SDK

Start the local remote-control server:

```bash
rika server --host 127.0.0.1 --port 4587 --token secret
```

IDE adapters and external clients should use `@rika/sdk` instead of duplicating HTTP details. CLI IDE helpers:

```bash
rika ide status --server http://127.0.0.1:4587 --token secret
rika ide connect --client my-editor --workspace /repo --capabilities active-context,navigation
rika ide open-file --path packages/cli/src/main.ts --start-line 1 --end-line 5
```

## Configuration

Rika reads configuration from three sources, in precedence order:

1. Process environment variables.
2. Workspace `.env.local`.
3. Global `~/.rika/settings.json`.

Use `~/.rika/settings.json` for machine-wide model defaults:

```json
{
  "api_key": "dummy",
  "base_url": "http://127.0.0.1:8317/v1"
}
```

Use `.env.local` in a development checkout when that workspace needs different model settings.

Common environment variables:

| Variable                                   | Purpose                                                |
| ------------------------------------------ | ------------------------------------------------------ |
| `RIKA_WORKSPACE_ROOT`                      | Default workspace root.                                |
| `RIKA_DATA_DIR`                            | Local data directory. Defaults to `<workspace>/.rika`. |
| `RIKA_DATABASE_URL`                        | Optional SQLite database URL/path override.            |
| `RIKA_API_KEY`                             | Model provider credentials.                            |
| `RIKA_BASE_URL`                            | Optional model provider proxy endpoint.                |
| `RIKA_BACKEND_URL` / `RIKA_BACKEND_TOKEN`  | Connect interactive TUI to an existing backend.        |
| `RIKA_BACKEND_PORT`                        | Override deterministic shared local backend port.      |
| `RIKA_RIVET_HOST`                          | `local` or `remote`.                                   |
| `RIKA_RIVET_ENDPOINT` / `RIVET_ENDPOINT`   | Rivet endpoint.                                        |
| `RIKA_RIVET_TOKEN` / `RIVET_TOKEN`         | Optional Rivet token.                                  |
| `RIKA_RIVET_NAMESPACE` / `RIVET_NAMESPACE` | Optional Rivet namespace.                              |
| `RIKA_INSTALL_DIR`                         | Destination for `install:local` / `update:local`.      |

## Persistence and Rivet hosting

Drizzle migrations are committed under `packages/persistence/drizzle/`.

```bash
bun run db:migrate
bun run --cwd packages/rivet-host dev
```

Remote Rivet hosting and recovery guidance lives in `docs/remote-rivet-hosting.md`.

## Pricing and support

Rika does not implement telemetry or hosted billing in this repo. Model provider, Rivet, and infrastructure costs are paid directly to those providers. Use GitHub issues for support during the initial launch.

## Security

Read `docs/SECURITY.md` before using Rika against untrusted repositories, workspaces, plugins, or MCP servers.
