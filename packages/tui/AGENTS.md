<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-27 | Updated: 2026-06-27 -->

# TUI Package

## Purpose

`packages/tui/` owns Rika's interactive terminal adapter. It renders protocol event streams into an Amp-like terminal surface, owns prompt/command-palette I/O, and delegates all agent work to Effect services.

## Key Files

| File                    | Purpose                                                         |
| ----------------------- | --------------------------------------------------------------- |
| `src/view-state.ts`     | Pure event-to-view projection for terminal rendering.           |
| `src/renderer.ts`       | Amp-like frame renderer with collapsed cards and status chrome. |
| `src/terminal.ts`       | Swappable terminal input/output boundary for live/tests.        |
| `src/session.ts`        | Interactive session loop over `AgentLoop.streamTurn`.           |
| `src/index.ts`          | Package namespace exports.                                      |
| `test/renderer.test.ts` | Snapshot-like render coverage for critical visual states.       |
| `test/session.test.ts`  | Memory-terminal interactive session tests.                      |

## Current Standards

- UI code consumes `@rika/schema` events and service streams; it must not reach into actor internals or persistence tables.
- Keep rendering mostly pure. Effects belong at terminal and agent-loop boundaries.
- Terminal I/O goes behind `Terminal.Service`; tests use `Terminal.memoryLayer`.
- Tool, diff, context, and historical cards are collapsed by default and expanded only by explicit view state.
- Preserve Amp-like chrome: top-right cost/mode, bottom-left activity, bottom-right workspace path, left-side spinner while active, and compact dark-terminal-friendly text.

## For AI Agents

- Read `../../docs/effect-module-conventions.md` before adding or changing services.
- Do not import Drizzle, Rivet, provider SDKs, or filesystem mutation APIs here.
- Keep the non-interactive NDJSON CLI behavior in `@rika/cli`; this package is for interactive terminal UX.

## Testing And Verification

- `bun run lint` from this package or from the repo root.
- `bun run typecheck` from this package or from the repo root.
- `bun run test` from this package or from the repo root.

<!-- MANUAL: Add human-maintained notes below this line. They are preserved by deep-init. -->
