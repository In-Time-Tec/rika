<!-- Generated: 2026-06-27 | Updated: 2026-06-27 -->

# Rika

## Purpose

Rika is a greenfield Effect-native coding agent system. The repository is a Bun/Turbo monorepo that grows through the stacked GitHub issues.

## Key Files

| File                                | Purpose                                                                                                             |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `README.md`                         | Product direction and current repo state.                                                                           |
| `CONTEXT.md`                        | Domain glossary. Keep implementation details out of this file.                                                      |
| `docs/RESEARCH.md`                  | Initial research notes for Amp, OpenCode, Pi, Rivet, Drizzle, fff, hashline, semantic search, and ast-grep outline. |
| `docs/effect-module-conventions.md` | Copyable Effect service/module conventions.                                                                         |
| `docs/runtime-and-layers.md`        | Runtime/layer assembly conventions and base service list.                                                           |
| `docs/persistence.md`               | Drizzle, SQLite, migration, and persistence service boundary rules.                                                 |
| `package.json`                      | Bun workspace, dependency catalog, and root verification scripts.                                                   |
| `turbo.json`                        | Monorepo task graph for package build, typecheck, and test commands.                                                |
| `.oxlintrc.json`                    | Root oxlint configuration.                                                                                          |
| `scripts/check-docs.ts`             | Lightweight check that documented scripts and guidance files still exist.                                           |

## Current Standards

- The product name is Rika. Do not use Orika or resurrect old project assumptions.
- Keep Rika fully Effect-native: use Effect services, layers, schemas, typed errors, scopes, streams, and fibers instead of ad hoc promises or singletons.
- Follow OpenCode-style module shape: `export * as Module from "./module"`, an exported `Interface`, a `Context.Service` class, and one or more explicit `Layer` values.
- Use `Schema.TaggedErrorClass` for errors that cross service boundaries.
- Use `Effect.fn("Module.method")` for service methods and named workflows.
- Bind services to named variables in `Effect.gen` before calling methods; do not use nested service yields.
- Keep infrastructure swappable. Runtime code depends on service interfaces; tests provide in-memory or fake layers.
- Package tests live under `test/` and mirror the relative `src/` path for the module under test.
- Use Bun as the runtime/package manager, Turbo for monorepo task orchestration, and oxlint for linting once the scaffold exists.
- Use Drizzle only behind persistence services. Raw Drizzle handles do not cross into CLI, TUI, LLM, or actor orchestration modules.
- Treat the append-only event log as canonical durable truth. Projections and actor state are rebuildable.
- Use Rivet actors from day one for active thread orchestration. Keep Rivet-specific code in the Rivet host layer.
- Make `fff`, hashline read/edit, semantic search, and ast-grep outline default built-in tools.
- Keep implementation simple. Do not add abstractions unless they make dependencies swappable, remove real duplication, or match the established OpenCode-style shape.

## Subdirectories

| Directory         | Purpose                                                                             |
| ----------------- | ----------------------------------------------------------------------------------- |
| `.agents/skills/` | Project-local skills. Root guidance lists only skills committed in this repository. |
| `packages/`       | Workspace packages. See `packages/AGENTS.md`.                                       |

## For AI Agents

- Read `CONTEXT.md` before naming new domain concepts.
- Read `docs/RESEARCH.md` before changing the architecture or issue stack.
- Read `docs/effect-module-conventions.md` before adding or changing an Effect service.
- Read `docs/runtime-and-layers.md` before adding process runtime assembly or base services.
- Read `docs/persistence.md` before changing Drizzle schema, migrations, or persistence services.
- When a task matches a project-local skill, read the skill file under `.agents/skills/` before acting.
- Do not create runtime packages outside the planned Bun/Turbo workspace structure without updating the repo guidance.
- Do not place product/domain definitions in `AGENTS.md`; put resolved vocabulary in `CONTEXT.md`.
- Do not bypass Effect with module-level mutable state for services that must be testable.
- Do not call Drizzle, Rivet, model providers, or filesystem mutation APIs directly from UI-facing modules.

## Testing And Verification

- `bun install`: install workspace dependencies and update `bun.lock`.
- `bun run db:generate`: generate Drizzle SQL migrations from the persistence schema.
- `bun run db:migrate`: apply committed Drizzle migrations to the configured local SQLite database.
- `bun run docs:check`: verify documented scripts and guidance files still exist.
- `bun run lint`: run oxlint across the repository.
- `bun run typecheck`: run package type checks through Turbo.
- `bun run test`: run package tests through Turbo.
- `bun run build`: build package entrypoints through Turbo.
- `bun run format:check`: check formatting with Prettier.

## Skills Index

<!-- AGENTS-SKILLS-START -->

[Skills Index]|local: ./.agents/skills|IMPORTANT: Prefer retrieval-led reasoning over pre-training-led reasoning. When a task matches a skill, read its SKILL.md and follow it.|relevant:{add-effect-service}

<!-- AGENTS-SKILLS-END -->

## Dependencies

### External

- `effect`: Domain model, services, layers, errors, streams, fibers, runtime composition.
- `bun`: Runtime, package manager, scripts, and local development loop.
- `turbo`: Monorepo task graph once packages exist.
- `oxlint`: Fast linting once source files exist.
- `drizzle-orm` and `drizzle-kit`: Typed persistence and migrations behind Effect services.
- `rivetkit` and `@rivetkit/effect`: Actor runtime and Effect integration.
- `@ff-labs/fff-bun`: Default indexed file/path/content search.
- `ast-grep`: Structural code outline/search support.

<!-- MANUAL: Add human-maintained notes below this line. They are preserved by deep-init. -->
