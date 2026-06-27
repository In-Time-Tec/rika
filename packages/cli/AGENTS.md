<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-27 | Updated: 2026-06-27 -->

# CLI Package

## Purpose

`packages/cli/` owns Rika's non-interactive command-line entrypoint. It parses process arguments, composes live or test layers, runs one agent turn, and writes newline-delimited protocol events for automation.

## Key Files

| File                   | Purpose                                                    |
| ---------------------- | ---------------------------------------------------------- |
| `src/args.ts`          | Pure argument parser for execute/run mode.                 |
| `src/execute.ts`       | Effect service that runs one command and streams NDJSON.   |
| `src/output.ts`        | Swappable stdout/stderr boundary for process and tests.    |
| `src/runtime.ts`       | Live layer assembly for the Bun CLI process.               |
| `src/main.ts`          | `rika` binary entrypoint.                                  |
| `test/execute.test.ts` | Fake model smoke tests for streaming JSON and diagnostics. |

## Current Standards

- Stdout is reserved for newline-delimited JSON protocol events; diagnostics go to stderr.
- CLI orchestration depends on `AgentLoop.Service`; provider SDKs, Drizzle, and filesystem details stay behind layers.
- Tests use fake model/tool layers and memory output, not process stdout or network providers.

## For AI Agents

- Read `../../docs/effect-module-conventions.md` before adding or changing CLI services.
- Keep interactive TUI behavior out of this package until the TUI issue.

## Testing And Verification

- `bun run lint` from this package or from the repo root.
- `bun run typecheck` from this package or from the repo root.
- `bun run test` from this package or from the repo root.

<!-- MANUAL: Add human-maintained notes below this line. They are preserved by deep-init. -->
