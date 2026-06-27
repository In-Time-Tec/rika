<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-27 | Updated: 2026-06-27 -->

# Persistence Package

## Purpose

`packages/persistence/` owns Drizzle-backed local SQLite adapters, migrations, and durable storage services. It is the only package where raw Drizzle and `bun:sqlite` handles are allowed.

## Key Files

| File                            | Purpose                                                          |
| ------------------------------- | ---------------------------------------------------------------- |
| `drizzle.config.ts`             | Drizzle Kit configuration for local SQLite migration generation. |
| `drizzle/`                      | Committed generated SQL migrations and Drizzle metadata.         |
| `src/database.ts`               | Effect `Database` service and SQLite connection layers.          |
| `src/migration.ts`              | Effect `Migration` service for runtime migration application.    |
| `src/schema/event-log.ts`       | Drizzle schema for the canonical event log tables.               |
| `src/schema/index.ts`           | Schema exports consumed by Drizzle Kit and services.             |
| `test/database.test.ts`         | Database layer replacement tests.                                |
| `test/migration.test.ts`        | Runtime migration service tests.                                 |
| `test/schema/event-log.test.ts` | Event log schema tests.                                          |

## Current Standards

- Keep Drizzle schema field names snake_case so column names do not need string remapping.
- Expose persistence behavior through Effect services and layers.
- Prefer `Database.memoryLayer` in tests; use file-backed `layerFromPath` only when testing file-specific SQLite behavior.
- Generated SQL migrations in `drizzle/` are committed. Do not hand-edit Drizzle metadata unless repairing a broken migration intentionally.
- Raw Drizzle handles may be used only inside this package.

## For AI Agents

- Read `../../docs/persistence.md` before changing schema, migrations, or persistence services.
- Read `../../docs/effect-module-conventions.md` before adding a new persistence service.
- Keep repository/domain services above this adapter boundary so future remote storage can swap in without UI or actor changes.

## Testing And Verification

- `bun run db:generate` from this package or from the repo root after schema changes.
- `bun run db:migrate` from this package or from the repo root to apply committed migrations locally.
- `bun run lint` from this package or `bun run lint` from the repo root.
- `bun run typecheck` from this package or `bun run typecheck` from the repo root.
- `bun run test` from this package or `bun run test` from the repo root.

## Skills Index

<!-- AGENTS-SKILLS-START -->

[Skills Index]|local: ../../.agents/skills|IMPORTANT: Prefer retrieval-led reasoning over pre-training-led reasoning. When a task matches a skill, read its SKILL.md and follow it.|relevant:{add-effect-service}

<!-- AGENTS-SKILLS-END -->

<!-- MANUAL: Add human-maintained notes below this line. They are preserved by deep-init. -->
