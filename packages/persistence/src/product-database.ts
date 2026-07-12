import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient"
import * as SqliteMigrator from "@effect/sql-sqlite-bun/SqliteMigrator"
import { Effect, FileSystem, Layer, Path } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"

const baseline = Effect.gen(function* () {
  const sql = yield* SqlClient
  yield* sql`CREATE TABLE rika_workspaces (
    path TEXT PRIMARY KEY NOT NULL,
    created_at INTEGER NOT NULL
  )`
  yield* sql`CREATE TABLE rika_threads (
    id TEXT PRIMARY KEY NOT NULL,
    session_id TEXT NOT NULL UNIQUE,
    workspace TEXT NOT NULL REFERENCES rika_workspaces(path),
    title TEXT NOT NULL,
    labels_json TEXT NOT NULL DEFAULT '[]',
    pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
    archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`
  yield* sql`CREATE INDEX rika_threads_listing ON rika_threads (pinned DESC, updated_at DESC, id ASC)`
})

const turns = Effect.gen(function* () {
  const sql = yield* SqlClient
  yield* sql`CREATE TABLE rika_turns (
    id TEXT PRIMARY KEY NOT NULL,
    thread_id TEXT NOT NULL REFERENCES rika_threads(id) ON DELETE CASCADE,
    prompt TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('accepted', 'running', 'waiting', 'completed', 'failed', 'cancelled')),
    last_cursor TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`
  yield* sql`CREATE INDEX rika_turns_thread ON rika_turns (thread_id, created_at ASC, id ASC)`
})

const queuedTurns = Effect.gen(function* () {
  const sql = yield* SqlClient
  yield* sql`CREATE TABLE rika_turns_next (
    id TEXT PRIMARY KEY NOT NULL,
    thread_id TEXT NOT NULL REFERENCES rika_threads(id) ON DELETE CASCADE,
    prompt TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('accepted', 'queued', 'running', 'waiting', 'completed', 'failed', 'cancelled')),
    last_cursor TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`
  yield* sql`INSERT INTO rika_turns_next SELECT * FROM rika_turns`
  yield* sql`DROP TABLE rika_turns`
  yield* sql`ALTER TABLE rika_turns_next RENAME TO rika_turns`
  yield* sql`CREATE INDEX rika_turns_thread ON rika_turns (thread_id, created_at ASC, id ASC)`
})

const executionExtensionPins = Effect.gen(function* () {
  const sql = yield* SqlClient
  yield* sql`ALTER TABLE rika_turns ADD COLUMN extension_pin_json TEXT`
})

const turnPromptParts = Effect.gen(function* () {
  const sql = yield* SqlClient
  yield* sql`ALTER TABLE rika_turns ADD COLUMN prompt_parts_json TEXT`
})

const dropThreadSessionId = Effect.gen(function* () {
  const sql = yield* SqlClient
  yield* sql`CREATE TABLE rika_threads_next (
    id TEXT PRIMARY KEY NOT NULL,
    workspace TEXT NOT NULL REFERENCES rika_workspaces(path),
    title TEXT NOT NULL,
    labels_json TEXT NOT NULL DEFAULT '[]',
    pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
    archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`
  yield* sql`INSERT INTO rika_threads_next SELECT id, workspace, title, labels_json, pinned, archived, created_at, updated_at FROM rika_threads`
  yield* sql`DROP TABLE rika_threads`
  yield* sql`ALTER TABLE rika_threads_next RENAME TO rika_threads`
  yield* sql`CREATE INDEX rika_threads_listing ON rika_threads (pinned DESC, updated_at DESC, id ASC)`
})

const migrations = SqliteMigrator.fromRecord({
  "1_product_baseline": baseline,
  "2_turns": turns,
  "3_queued_turn_status": queuedTurns,
  "4_execution_extension_pins": executionExtensionPins,
  "5_turn_prompt_parts": turnPromptParts,
  "6_drop_thread_session_id": dropThreadSessionId,
})
const migrate = SqliteMigrator.layer({ loader: migrations, table: "rika_migrations" })

const directoryLayer = (filename: string) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      yield* fileSystem.makeDirectory(path.dirname(filename), { recursive: true })
    }),
  )

export const clientLayer = (filename: string) =>
  SqliteClient.layer({ filename }).pipe(Layer.provideMerge(directoryLayer(filename)))
export const layer = (filename: string) => migrate.pipe(Layer.provideMerge(clientLayer(filename)))
