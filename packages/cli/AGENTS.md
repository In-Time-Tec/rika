<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-27 | Updated: 2026-06-27 -->

# CLI Package

## Purpose

`packages/cli/` owns Rika's command-line process entrypoint. It parses process arguments, routes no-arg interactive sessions to `@rika/tui`, runs non-interactive turns for automation, and preserves newline-delimited protocol events on stdout for execute mode.

## Key Files

| File                         | Purpose                                                                          |
| ---------------------------- | -------------------------------------------------------------------------------- |
| `src/args.ts`                | Pure argument parser for interactive and execute/run modes.                      |
| `src/doctor.ts`              | Local diagnostics command with no telemetry upload.                              |
| `src/execute.ts`             | Effect service that runs one command and streams NDJSON.                         |
| `src/extensions.ts`          | CLI self-extension commands for skill/plugin creation and rollback.              |
| `src/ide.ts`                 | CLI IDE client commands backed by the remote-control SDK.                        |
| `src/local-backend.ts`       | Shared local backend discovery, lock, spawn, health, status, and web dev record. |
| `src/mcp.ts`                 | CLI MCP server list/approval command executor.                                   |
| `src/output.ts`              | Swappable stdout/stderr boundary for process and tests.                          |
| `src/review.ts`              | CLI review command executor that prints machine-readable JSON.                   |
| `src/runtime.ts`             | Live layer assembly and routing for the Bun CLI process.                         |
| `src/server.ts`              | CLI command executor for the local remote-control server.                        |
| `src/skills.ts`              | CLI skill list/inspect command executor.                                         |
| `src/threads.ts`             | CLI thread lifecycle/search/share command executor.                              |
| `src/main.ts`                | `rika` binary entrypoint.                                                        |
| `test/args.test.ts`          | Effect CLI parser contract tests.                                                |
| `test/doctor.test.ts`        | Doctor report and secret-redaction tests.                                        |
| `test/execute.test.ts`       | Fake model smoke tests for streaming JSON and diagnostics.                       |
| `test/extensions.test.ts`    | Self-extension command output tests over a fake service.                         |
| `test/ide.test.ts`           | IDE command tests over an in-memory SDK transport.                               |
| `test/local-backend.test.ts` | Shared local backend race, stale record, and redaction tests.                    |
| `test/mcp.test.ts`           | MCP list/approval command output tests.                                          |
| `test/review.test.ts`        | Review command JSON output tests over a fake review service.                     |
| `test/server.test.ts`        | Remote-control server command output tests.                                      |
| `test/skills.test.ts`        | Skill command output tests over fake skill registries.                           |
| `test/threads.test.ts`       | Thread command output tests over memory persistence.                             |

## Current Standards

- Stdout is reserved for newline-delimited JSON protocol events; diagnostics go to stderr.
- CLI orchestration depends on `AgentLoop.Service` and `Session.Service`; provider SDKs, Drizzle, terminal I/O, and filesystem details stay behind layers.
- Live runtime composition owns provider selection, built-in tools, plugins, persistence, diagnostics, SDK, TUI session backends, and local remote-control server layers; keep that assembly out of feature modules.
- The local backend record under the data directory is also consumed by the Foldkit web dev proxy. Keep its URL/token/workspace fields private, stable, and redacted in diagnostics.
- Runtime environment loading may merge process env and settings files, but secrets and tokens must be redacted in doctor/status output.
- Tests use fake model/tool layers and memory output, not process stdout or network providers.

## For AI Agents

- Read `../../docs/effect-module-conventions.md` before adding or changing CLI services.
- Keep interactive rendering in `@rika/tui`; this package should only parse, route, and compose live layers.
- When adding startup config, update `src/runtime-env.ts`, doctor redaction, owner docs, and package smoke expectations together.

## Testing And Verification

- `bun run lint` from this package or from the repo root.
- `bun run typecheck` from this package or from the repo root.
- `bun run test` from this package or from the repo root.

<!-- MANUAL: Add human-maintained notes below this line. They are preserved by deep-init. -->
