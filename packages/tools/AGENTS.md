<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-27 | Updated: 2026-06-27 -->

# Tools Package

## Purpose

`packages/tools/` owns built-in agent tools and adapter services that touch the local workspace, filesystem, search indexes, and external helper packages. It registers tools through `@rika/agent`'s `ToolRegistry` boundary.

## Key Files

| File                    | Purpose                                                     |
| ----------------------- | ----------------------------------------------------------- |
| `src/hashline-file.ts`  | Hashline read/write/edit service and tool registry layer.   |
| `src/index.ts`          | Package namespace exports.                                  |
| `test/hashline-file.ts` | Hashline anchor, edit validation, and write behavior tests. |

## Current Standards

- Export each service module through `src/index.ts` as `export * as Module from "./module"`.
- Keep filesystem mutation behind Effect services and layers so tests can swap implementations.
- Register built-in tools by returning `ToolRegistry.Definition` values or a `ToolRegistry.Service` layer.
- Tool outputs should include structured metadata for future TUI rendering rather than terminal-only strings.

## For AI Agents

- Read `../../docs/effect-module-conventions.md` before adding services.
- Do not import model providers, Rivet, Drizzle, or CLI/TUI process output here.
- Keep built-in tool behavior strict: reject stale anchors or ambiguous edits instead of guessing.

## Testing And Verification

- `bun run lint` from this package or from the repo root.
- `bun run typecheck` from this package or from the repo root.
- `bun run test` from this package or from the repo root.

<!-- MANUAL: Add human-maintained notes below this line. They are preserved by deep-init. -->
