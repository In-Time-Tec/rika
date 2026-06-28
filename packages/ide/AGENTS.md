<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-28 | Updated: 2026-06-28 -->

# IDE Package

## Purpose

`packages/ide/` owns Rika's editor integration seam. It tracks an optional connected IDE client, translates editor context into agent context entries, and records navigation requests without binding Rika to a specific editor extension.

## Key Files

| File                      | Purpose                                                     |
| ------------------------- | ----------------------------------------------------------- |
| `src/ide-bridge.ts`       | Effect service for IDE connection, context, and navigation. |
| `src/index.ts`            | Package namespace exports.                                  |
| `test/ide-bridge.test.ts` | In-memory IDE bridge and context-entry tests.               |

## Current Standards

- Keep editor state optional. Missing IDE support must not change CLI/TUI-only behavior.
- Keep editor protocols typed through `@rika/schema` and replaceable through `IdeBridge.Service`.
- Treat IDE-provided context as user/workspace data, not policy.
- Do not import editor SDKs, Drizzle, Rivet, model providers, or filesystem mutation APIs here.

## Testing And Verification

- `bun run lint` from this package or from the repo root.
- `bun run typecheck` from this package or from the repo root.
- `bun run test` from this package or from the repo root.

<!-- MANUAL: Add human-maintained notes below this line. They are preserved by deep-init. -->
