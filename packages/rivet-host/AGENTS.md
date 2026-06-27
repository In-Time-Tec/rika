<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-27 | Updated: 2026-06-27 -->

# Rivet Host Package

## Purpose

`packages/rivet-host/` owns RivetKit actor definitions, local host assembly, and the adapter boundary between Rivet actors and Rika Effect services. It is the only package where raw `rivetkit` or `@rivetkit/effect` imports are allowed.

## Key Files

| File                       | Purpose                                                   |
| -------------------------- | --------------------------------------------------------- |
| `src/thread-actor.ts`      | Public ThreadActor contract and typed action schemas.     |
| `src/thread-live.ts`       | Server-side ThreadActor implementation and replay bridge. |
| `src/local-host.ts`        | Local Rivet registry/layer assembly.                      |
| `src/main.ts`              | Bun local development entrypoint.                         |
| `src/index.ts`             | Package namespace exports.                                |
| `test/thread-live.test.ts` | ThreadActor replay and lifecycle smoke tests.             |

## Current Standards

- Keep raw Rivet imports inside this package.
- Actor hot state is rebuildable. Canonical facts live in `@rika/persistence`'s event log.
- Use `@rivetkit/effect` contracts and layers for actor code; do not wrap actor calls in ad hoc promises.
- Keep Drizzle access behind persistence services, even inside actors.

## For AI Agents

- Read `../../docs/effect-module-conventions.md` and `../../docs/runtime-and-layers.md` before adding host services.
- Read `../../docs/persistence.md` before changing actor persistence behavior.
- Prefer the current `@rivetkit/effect` public examples over older `actor-core` or `@rivet-gg/actor` APIs.

## Testing And Verification

- `bun run lint` from this package or from the repo root.
- `bun run typecheck` from this package or from the repo root.
- `bun run test` from this package or from the repo root.
- `RIVET_RUN_ENGINE=1 bun run dev` from this package starts the local Rivet engine and registry.

<!-- MANUAL: Add human-maintained notes below this line. They are preserved by deep-init. -->
