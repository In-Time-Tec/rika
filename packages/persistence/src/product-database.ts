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
    workspace TEXT NOT NULL REFERENCES rika_workspaces(path),
    title TEXT NOT NULL,
    labels_json TEXT NOT NULL DEFAULT '[]',
    pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
    archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`
  yield* sql`CREATE INDEX rika_threads_listing ON rika_threads (pinned DESC, updated_at DESC, id ASC)`
  yield* sql`CREATE TABLE rika_turns (
    id TEXT PRIMARY KEY NOT NULL,
    thread_id TEXT NOT NULL REFERENCES rika_threads(id) ON DELETE CASCADE,
    prompt TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('accepted', 'queued', 'running', 'waiting', 'completed', 'failed', 'cancelled')),
    last_cursor TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    extension_pin_json TEXT,
    prompt_parts_json TEXT,
    execution_route_json TEXT,
    review_fan_out_id TEXT
  )`
  yield* sql`CREATE INDEX rika_turns_thread ON rika_turns (thread_id, created_at ASC, id ASC)`
  yield* sql`CREATE TABLE rika_thread_turn_activity (
    turn_id TEXT PRIMARY KEY NOT NULL REFERENCES rika_turns(id) ON DELETE CASCADE,
    thread_id TEXT NOT NULL REFERENCES rika_threads(id) ON DELETE CASCADE,
    projected_cursor TEXT,
    complete INTEGER NOT NULL DEFAULT 0 CHECK (complete IN (0, 1)),
    added INTEGER NOT NULL DEFAULT 0 CHECK (added >= 0),
    modified INTEGER NOT NULL DEFAULT 0 CHECK (modified >= 0),
    removed INTEGER NOT NULL DEFAULT 0 CHECK (removed >= 0),
    last_event_at INTEGER,
    updated_at INTEGER NOT NULL
  )`
  yield* sql`CREATE INDEX rika_thread_turn_activity_summary ON rika_thread_turn_activity (thread_id, last_event_at DESC)`
  yield* sql`CREATE TABLE rika_thread_read_state (
    thread_id TEXT PRIMARY KEY NOT NULL REFERENCES rika_threads(id) ON DELETE CASCADE,
    last_read_at INTEGER NOT NULL
  )`
})

const migrations = SqliteMigrator.fromRecord({
  "1_product_baseline": baseline,
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
