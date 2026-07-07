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

## Settings

Rika reads optional JSON settings from `~/.config/rika/settings.json` and then `<workspace>/.rika/settings.json`. Workspace settings override user settings for scalar settings. `keymap` is the documented exception: user keymap entries override workspace keymap entries. Environment variables override scalar settings only.

Recognized keys:

| Setting                   | Environment override            | Default                  |
| ------------------------- | ------------------------------- | ------------------------ |
| `orb.template`            | `RIKA_ORB_TEMPLATE`             | `rika-orb`               |
| `orb.idleTimeoutSeconds`  | `RIKA_ORB_IDLE_TIMEOUT`         | `300`                    |
| `project.default`         | `RIKA_ORB_PROJECT`              | unset                    |
| `mode.default`            | `RIKA_MODE`                     | `smart`                  |
| `compaction.auto`         | `RIKA_COMPACTION_AUTO`          | unset                    |
| `compaction.reserved`     | `RIKA_COMPACTION_RESERVED`      | unset                    |
| `compaction.prune`        | `RIKA_COMPACTION_PRUNE`         | unset                    |
| `compaction.pruneProtect` | `RIKA_COMPACTION_PRUNE_PROTECT` | unset                    |
| `compaction.pruneMinimum` | `RIKA_COMPACTION_PRUNE_MINIMUM` | unset                    |
| `memory.autoContext`      | `RIKA_MEMORY_AUTO_CONTEXT`      | `false`                  |
| `keymap`                  | none                            | `{}`                     |
| `telemetry.enabled`       | `RIKA_TELEMETRY`                | `true`                   |
| `telemetry.endpoint`      | `RIKA_TELEMETRY_ENDPOINT`       | `http://127.0.0.1:27686` |

Malformed settings files produce doctor/runtime warnings where surfaced and fall back to the next source instead of crashing startup.

`keymap` is an object keyed by `rika config keymap` action id. Values are chord strings or `null`; `null` unbinds that action. Chords are space-separated sequences such as `ctrl+x u`; `<leader>` expands through the `leader` entry, which defaults to `ctrl+x`.

```json
{
  "keymap": {
    "leader": "ctrl+a",
    "palette.open": "ctrl+p",
    "thread.newRemote": "<leader> r",
    "mode.next": null
  }
}
```

Use `rika config list` to print the effective non-secret configuration with the source for each scalar value. Use `rika config keymap` to print keymap entries with `id`, `chord`, `description`, and `source`. Use `rika config edit` for user settings and `rika config edit --workspace` for workspace settings. Unknown keys and wrong value types produce warnings after the editor exits, but do not block saving. Unknown keymap action ids and unparsable keymap chords produce a startup warning in the TUI status line, and the invalid binding is ignored.

Set `memory.autoContext` to `true` to let resolved context include up to three high-similarity past thread references from the same workspace. The default is `false`; unavailable embeddings produce no automatic memory entries. Use `rika threads search --semantic "<query>"` to search indexed thread memory manually. If embeddings are unavailable, the CLI prints a notice and falls back to lexical thread search.

## Orb template

Build the E2B sandbox template for orb execution with:

```bash
E2B_API_KEY=e2b_... bun run orb:template
```

The build prepares a Linux x64 Rika release artifact, copies it with the required share assets into `infra/orb-template/.build/`, and invokes the E2B template CLI. Runtime orb provisioning resolves the template from `RIKA_ORB_TEMPLATE`, then the selected project's `template_id`, then `orb.template`, then `rika-orb`. The image installs the runtime tools, puts `rika` on `PATH` at `/opt/rika/bin/rika`, and uses `/home/user/repo` as the canonical workspace root.

Validate the committed template contract without Docker or E2B:

```bash
bun run orb:template:contract
```

Run the image-level smoke with Docker:

```bash
bun run orb:template:smoke
```

## Get started

```bash
rika doctor
rika
rika --execute "summarize this repo" --mode smart
```

`rika doctor` prints local diagnostics as JSON and does not upload telemetry. It reports whether `E2B_API_KEY` is configured, checks the resolved orb template when the key is present, verifies running orb records through authenticated `/health`, and lists Rika sandboxes that are not present in the local orb store with `e2b sandbox kill <sandbox-id>` cleanup commands.

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
rika threads compact <thread-id>
rika threads share <thread-id>
rika threads reference <thread-id> [query]
rika threads rebuild-projection
rika memory status
rika memory index --workspace /repo
```

Thread search treats bare words and quoted phrases as text terms. It also accepts inline filters: `file:<glob>`, `after:<ISO-date|24h|7d>`, `before:<ISO-date|24h|7d>`, `archived:true|false`, and `project:<name>`. In a shell command, escape literal quotes when the phrase itself must reach Rika, such as `rika threads search '"auth race"'`.

Use `rika threads rebuild-projection` to reconstruct thread summaries and file search projection rows from the canonical event log after suspected projection corruption.

Interactive slash commands mirror the core lifecycle: `/threads`, `/search`, `/thread`, `/new`, `/archive`, `/unarchive`, `/compact`, `/share`, and `/reference`.

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

Subagents run isolated bounded tasks and return compact summaries. Local processes default to read-only subagent tools. Set `RIKA_SUBAGENT_TOOLS=full` to expose the standard toolset to subagents without the recursive `task` tool; orb servers are launched this way automatically. Skills are task-specific instruction packages discovered from project/user locations and loaded explicitly.

CLI skill commands:

```bash
rika skills list
rika skills inspect <name>
rika skills add owner/repo/path/to/skill
rika skills add https://github.com/owner/repo --user
rika skills remove <name>
```

`rika skills add` clones the source with Git, validates `SKILL.md`, installs into `.agents/skills/<name>/` by default, and records provenance in `.agents/skills/skills-lock.json`. Use `--user` to install under `~/.config/rika/skills/<name>/`. Existing skills are not overwritten unless `--force` is set. `rika skills remove` deletes the selected skill directory and its lockfile entry.

## Code review

Run local review with:

```bash
rika review --staged
rika review --base main packages/agent/src
```

Review checks live in `.agents/checks/` and are executed through read-only subagent boundaries by default.

## MCP

MCP servers are external tool providers. Workspace command servers require explicit approval by server name, config fingerprint, and effective launch directory:

```bash
rika mcp add context7 -- npx -y @upstash/context7-mcp
rika mcp add docs --url https://example.com/mcp
rika mcp list
rika mcp doctor
rika mcp approve <server-name>
rika mcp remove context7
```

`rika mcp add` writes `rika.mcpServers` in `<workspace>/.rika/settings.json` by default. Use `--global` to target `~/.config/rika/settings.json`. Skills may also bundle an `mcp.json` next to `SKILL.md`; `list`, `doctor`, and `approve` include those servers, but their tools are registered only on turns where that skill is explicitly loaded.

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

## Local web UI

The Foldkit web UI is available for local development from the source checkout:

```bash
rika
bun run web:dev
```

Open `http://127.0.0.1:4590`. The web UI connects through the same shared local backend as the TUI, so two terminal windows and the browser all render the same thread events. Turn submission is submit-only; all visible transcript updates arrive through the shared thread subscription. A specific thread can be opened with `?thread=<thread-id>`.

The development server proxies `/api/rika/*` to the backend recorded in `<workspace>/.rika/local-backend.json` and injects the local backend token server-side. Use `RIKA_WORKSPACE_ROOT` or `RIKA_DATA_DIR` when the web UI should follow a different workspace. See `docs/local-web-sync.md` for the contract.

## Non-interactive and streaming JSON

Use non-interactive mode for scripts and CI:

```bash
rika run --mode rush "write a short summary"
rika --execute --workspace /repo --thread thread_123 "continue the task"
```

Stdout is newline-delimited protocol events. Diagnostics go to stderr.

## Orb sync

Mirror changes from a running orb thread into a local worktree:

```bash
rika sync thread_123
```

The command writes to `<workspace>/.rika/worktrees/<thread-id>` on branch `rika/orb/<thread-id>`, verifies the orb base commit exists locally, resets the worktree to that base, cleans stale untracked files, and applies the orb's binary diff. Empty orb diffs print `no changes yet`.

## Orb tournament

Run the same task in two to four fresh orbs, judge the resulting diffs, and optionally sync the winner:

```bash
rika orb tournament "implement the fix" -n 3 --project demo --modes smart,deep2,deep3 --rubric "prefer tested diffs"
rika orb tournament "implement the fix" -n 2 --project demo --sync-winner --yes
```

The command requires an explicit `-n`/`--branches` value and asks for confirmation before provisioning sandboxes unless `--yes` is present. Failed turns and empty diffs are excluded from judging; if fewer than two candidates survive, the command reports each outcome, cleans up provisioned orbs, and exits non-zero. Winners receive an `Orb tournament verdict` artifact. Losing orbs are killed after their final diffs are stored unless `--keep-losers` is present.

## Orb usage

Inspect orb running-minute visibility:

```bash
rika orb usage
rika orb usage --project demo --since 2026-07-03T00:00:00Z
```

The report prints thread, project, total running minutes, interval count, and a grand total. It is an operations and hosted-control-plane seam, not a billing system.

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

Rika imports process environment from three sources, in precedence order:

1. Process environment variables.
2. Workspace `.env.local`.
3. Legacy global `~/.rika/settings.json`.

Use `~/.rika/settings.json` only for legacy machine-wide model credentials:

```json
{
  "api_key": "dummy",
  "base_url": "http://127.0.0.1:8317/v1"
}
```

Use `.env.local` in a development checkout when that workspace needs different model credentials. Use `~/.config/rika/settings.json` and `<workspace>/.rika/settings.json` for general preferences such as default mode, compaction, telemetry, and orb defaults.

Common environment variables:

| Variable                                   | Purpose                                                     |
| ------------------------------------------ | ----------------------------------------------------------- |
| `RIKA_MODE`                                | Default agent mode when no command flag overrides it.       |
| `RIKA_WORKSPACE_ROOT`                      | Default workspace root.                                     |
| `RIKA_DATA_DIR`                            | Local data directory. Defaults to `<workspace>/.rika`.      |
| `RIKA_DATABASE_URL`                        | Optional SQLite database URL/path override.                 |
| `RIKA_TELEMETRY`                           | Enable or disable local OTLP telemetry export.              |
| `RIKA_TELEMETRY_ENDPOINT`                  | OTLP base URL for traces and logs.                          |
| `RIKA_COMPACTION_*`                        | Optional automatic compaction thresholds and pruning knobs. |
| `RIKA_SUBAGENT_TOOLS`                      | `readonly` or `full`; local default is `readonly`.          |
| `RIKA_API_KEY`                             | Model provider credentials.                                 |
| `RIKA_EMBEDDINGS_API_KEY`                  | Optional dedicated key for thread memory embeddings.        |
| `RIKA_BASE_URL`                            | Optional model provider proxy endpoint.                     |
| `RIKA_BACKEND_URL` / `RIKA_BACKEND_TOKEN`  | Connect interactive TUI to an existing backend.             |
| `RIKA_BACKEND_PORT`                        | Override deterministic shared local backend port.           |
| `VITE_RIKA_API_BASE_URL`                   | Optional web UI API base override; defaults to `/api/rika`. |
| `RIKA_RIVET_HOST`                          | `local` or `remote`.                                        |
| `RIKA_RIVET_ENDPOINT` / `RIVET_ENDPOINT`   | Rivet endpoint.                                             |
| `RIKA_RIVET_TOKEN` / `RIVET_TOKEN`         | Optional Rivet token.                                       |
| `RIKA_RIVET_NAMESPACE` / `RIVET_NAMESPACE` | Optional Rivet namespace.                                   |
| `RIKA_INSTALL_DIR`                         | Destination for `install:local` / `update:local`.           |

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
