<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-28 | Updated: 2026-06-28 -->

# SDK Package

## Purpose

`packages/sdk/` owns the TypeScript client for Rika's remote-control API, including IDE integration endpoints. It is typed from `@rika/schema` and exposes Effect/Stream-native methods plus a fetch transport.

## Key Files

| File            | Purpose                                       |
| --------------- | --------------------------------------------- |
| `src/client.ts` | Effect-native SDK client and fetch transport. |
| `src/index.ts`  | Package namespace exports.                    |

## Current Standards

- Keep SDK payloads decoded through shared `@rika/schema` contracts.
- Keep transport swappable so tests can use in-process transports and consumers can use HTTP fetch.
- Do not import agent, server, Drizzle, Rivet, model providers, or filesystem adapters here.

## Testing And Verification

- `bun run lint` from this package or from the repo root.
- `bun run typecheck` from this package or from the repo root.
- `bun run test` from this package or from the repo root.

<!-- MANUAL: Add human-maintained notes below this line. They are preserved by deep-init. -->
