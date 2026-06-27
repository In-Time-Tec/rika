# Persistence

Rika persists durable thread facts through a local SQLite database managed by Drizzle. Drizzle is an adapter detail: packages outside `@rika/persistence` should depend on repository-style services, not raw Drizzle handles.

## Migration flow

- Drizzle schema lives under `packages/persistence/src/schema/`.
- Generated SQL migrations live under `packages/persistence/drizzle/` and are committed.
- Generate migrations with `bun run db:generate` from the repository root.
- Apply committed migrations with `bun run db:migrate` from the repository root.
- Runtime entrypoints apply migrations through the `Migration` Effect service, not by invoking `drizzle-kit` directly.

## SQLite defaults

The `Database` service owns SQLite connection setup and centralizes pragmas:

- `foreign_keys = ON`
- `busy_timeout = 5000`
- `journal_mode = WAL` for file-backed databases
- `synchronous = NORMAL`

Tests should use `Database.memoryLayer` unless the behavior being tested requires a file-backed SQLite database.

## Boundaries

- Raw Drizzle and `bun:sqlite` handles stay in persistence modules.
- Core, CLI, TUI, actor, LLM, and tool orchestration code must not import Drizzle directly.
- The append-only event log is canonical durable truth. Projections remain rebuildable.
