<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-27 | Updated: 2026-06-27 -->

# Tools Package

## Purpose

`packages/tools/` owns built-in agent tools and adapter services that touch the local workspace, filesystem, search indexes, and external helper packages. It registers tools through `@rika/agent`'s `ToolRegistry` boundary.

## Key Files

| File                            | Purpose                                                               |
| ------------------------------- | --------------------------------------------------------------------- |
| `src/ast-grep-outline.ts`       | ast-grep outline structural navigation service and tool.              |
| `src/builtins.ts`               | Composed live built-in tool registry and executor layer.              |
| `src/fff-search.ts`             | fff-backed path, glob, directory, grep, multi-grep, and health tools. |
| `src/hashline-file.ts`          | Hashline read/write/edit service and tool registry layer.             |
| `src/index.ts`                  | Package namespace exports.                                            |
| `src/mcp-client.ts`             | MCP client adapter, config loading, tool mapping, and trust gating.   |
| `src/semantic-search.ts`        | Semantic/hybrid code search service, fake layer, and built-in tool.   |
| `src/specialty-tools.ts`        | Oracle/librarian/painter-style specialty tool service and artifacts.  |
| `test/ast-grep-outline.test.ts` | Outline args, caps, path safety, and registry behavior tests.         |
| `test/fff-search.test.ts`       | fff fake/fallback, pagination, anchors, and registry tests.           |
| `test/hashline-file.test.ts`    | Hashline anchor, edit validation, and write behavior tests.           |
| `test/mcp-client.test.ts`       | MCP trust gating, tool filtering, and executor mapping tests.         |
| `test/semantic-search.test.ts`  | Semantic search fake/live fallback, diagnostics, and tool tests.      |
| `test/specialty-tools.test.ts`  | Specialty provider substitution, artifacts, and permission tests.     |

## Current Standards

- Export each service module through `src/index.ts` as `export * as Module from "./module"`.
- Keep filesystem mutation behind Effect services and layers so tests can swap implementations.
- Register built-in tools by returning `ToolRegistry.Definition` values or a `ToolRegistry.Service` layer.
- Tool outputs should include structured metadata for future TUI rendering rather than terminal-only strings.
- Use `semantic_search` first for behavior/concept/data-flow discovery, but keep fff as the exact path/content search fallback.
- Use `ast_grep_outline` after search has identified candidate files or directories and before broad reads of large source files.
- Specialty tools persist research/image outputs as artifacts and must remain swappable behind `SpecialtyTools.Service`.
- Live CLI and Rivet host tool composition goes through `BuiltInTools.toolExecutorLayer` so default search, outline, read, write, edit, and shell tools stay consistent.

## For AI Agents

- Read `../../docs/effect-module-conventions.md` before adding services.
- Do not import model providers, Rivet, Drizzle, or CLI/TUI process output here. Route specialty model use through `@rika/llm` services, not provider SDKs.
- Keep built-in tool behavior strict: reject stale anchors or ambiguous edits instead of guessing.

## Testing And Verification

- `bun run lint` from this package or from the repo root.
- `bun run typecheck` from this package or from the repo root.
- `bun run test` from this package or from the repo root.

<!-- MANUAL: Add human-maintained notes below this line. They are preserved by deep-init. -->
