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
- `ThreadEventLog` owns event append/read invariants. `ThreadProjection` owns rebuildable thread list, latest message, and active turn read models.
- `ThreadProjection` also owns the rebuildable `thread_files` read model for file-filtered thread search. It is derived from thread event payloads and can be cleared and rebuilt with the rest of the projection state.
- `ThreadMemoryStore` owns per-turn digest chunks and little-endian Float32 embedding blobs. Search applies workspace/thread filters first, then brute-force cosine ranks the newest 20,000 matching chunks. `sqlite-vec` is the intended future adapter when brute-force search is no longer enough.
- Backend and orb lifecycle recovery writes synthetic `turn.failed` events to the same append-only log. Projection replay treats the first terminal event for a turn as authoritative while keeping sequence advancement monotonic for later terminal events on that same turn.
- Thread forks copy conversation events into a new thread id and may preserve `artifact.created` payloads that point at source-thread artifacts. Forking does not copy artifact rows.
- `WorkspaceStore` owns durable workspace memberships for hosted access. Authorization decisions stay in `WorkspaceAccess`, not in the Drizzle adapter.
- `OrbStore` owns orb lifecycle rows and usage intervals. `setStatus` is the only writer for opening and closing running intervals; startup repair closes stale open intervals for non-running orbs after migrations apply.
