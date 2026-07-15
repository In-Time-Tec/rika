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

const executionRoutePins = Effect.gen(function* () {
  const sql = yield* SqlClient
  yield* sql`ALTER TABLE rika_turns ADD COLUMN execution_route_json TEXT`
})

const reviewFanOutOwners = Effect.gen(function* () {
  const sql = yield* SqlClient
  yield* sql`ALTER TABLE rika_turns ADD COLUMN review_fan_out_id TEXT`
})

const transcriptProjection = Effect.gen(function* () {
  const sql = yield* SqlClient
  yield* sql`CREATE TABLE rika_transcript_entries (
    turn_id TEXT PRIMARY KEY NOT NULL REFERENCES rika_turns(id) ON DELETE CASCADE,
    thread_id TEXT NOT NULL REFERENCES rika_threads(id) ON DELETE CASCADE,
    prompt TEXT NOT NULL,
    status TEXT NOT NULL,
    events_json TEXT NOT NULL DEFAULT '[]',
    revision INTEGER NOT NULL DEFAULT 1,
    projection_version INTEGER NOT NULL DEFAULT 1,
    oldest_cursor TEXT,
    checkpoint_cursor TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`
  yield* sql`CREATE INDEX rika_transcript_page ON rika_transcript_entries (thread_id, created_at DESC, turn_id DESC)`
})

const threadSummaries = Effect.gen(function* () {
  const sql = yield* SqlClient
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

const semanticTranscriptProjection = Effect.gen(function* () {
  const sql = yield* SqlClient
  yield* sql`CREATE TABLE rika_transcript_checkpoints (
    turn_id TEXT PRIMARY KEY NOT NULL REFERENCES rika_turns(id) ON DELETE CASCADE,
    thread_id TEXT NOT NULL REFERENCES rika_threads(id) ON DELETE CASCADE,
    drafts_json TEXT NOT NULL DEFAULT '[]',
    revision INTEGER NOT NULL DEFAULT -1,
    projection_version INTEGER NOT NULL DEFAULT 2,
    oldest_cursor TEXT,
    checkpoint_cursor TEXT,
    cost_usd REAL,
    updated_at INTEGER NOT NULL
  )`
  yield* sql`CREATE TABLE rika_transcript_units (
    unit_key TEXT PRIMARY KEY NOT NULL,
    turn_id TEXT NOT NULL REFERENCES rika_turns(id) ON DELETE CASCADE,
    thread_id TEXT NOT NULL REFERENCES rika_threads(id) ON DELETE CASCADE,
    unit_sequence INTEGER NOT NULL,
    unit_part INTEGER NOT NULL,
    revision INTEGER NOT NULL,
    unit_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`
  yield* sql`CREATE INDEX rika_transcript_units_page ON rika_transcript_units (
    thread_id, created_at DESC, turn_id DESC, unit_sequence DESC, unit_part DESC, unit_key DESC
  )`
  yield* sql`CREATE INDEX rika_transcript_units_turn ON rika_transcript_units (
    turn_id, unit_sequence ASC, unit_part ASC, unit_key ASC
  )`
})

const migrations = SqliteMigrator.fromRecord({
  "1_product_baseline": baseline,
  "2_turns": turns,
  "3_queued_turn_status": queuedTurns,
  "4_execution_extension_pins": executionExtensionPins,
  "5_turn_prompt_parts": turnPromptParts,
  "6_drop_thread_session_id": dropThreadSessionId,
  "7_execution_route_pins": executionRoutePins,
  "8_review_fan_out_owners": reviewFanOutOwners,
  "9_transcript_projection": transcriptProjection,
  "10_thread_summaries": threadSummaries,
  "11_semantic_transcript_projection": semanticTranscriptProjection,
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
