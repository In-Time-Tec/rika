<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-27 | Updated: 2026-06-27 -->

# CLI Package

## Purpose

`packages/cli/` owns Rika's command-line process entrypoint. It parses process arguments, routes no-arg interactive sessions to `@rika/tui`, runs non-interactive turns for automation, and preserves newline-delimited protocol events on stdout for execute mode.

## Key Files

| File                   | Purpose                                                     |
| ---------------------- | ----------------------------------------------------------- |
| `src/args.ts`          | Pure argument parser for interactive and execute/run modes. |
| `src/execute.ts`       | Effect service that runs one command and streams NDJSON.    |
| `src/output.ts`        | Swappable stdout/stderr boundary for process and tests.     |
| `src/runtime.ts`       | Live layer assembly and routing for the Bun CLI process.    |
| `src/main.ts`          | `rika` binary entrypoint.                                   |
| `test/args.test.ts`    | Effect CLI parser contract tests.                           |
| `test/execute.test.ts` | Fake model smoke tests for streaming JSON and diagnostics.  |

## Current Standards

- Stdout is reserved for newline-delimited JSON protocol events; diagnostics go to stderr.
- CLI orchestration depends on `AgentLoop.Service` and `Session.Service`; provider SDKs, Drizzle, terminal I/O, and filesystem details stay behind layers.
- Tests use fake model/tool layers and memory output, not process stdout or network providers.

## For AI Agents

- Read `../../docs/effect-module-conventions.md` before adding or changing CLI services.
- Keep interactive rendering in `@rika/tui`; this package should only parse, route, and compose live layers.

## Testing And Verification

- `bun run lint` from this package or from the repo root.
- `bun run typecheck` from this package or from the repo root.
- `bun run test` from this package or from the repo root.

<!-- MANUAL: Add human-maintained notes below this line. They are preserved by deep-init. -->
