import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"

export const migration018 = Effect.gen(function* () {
  const sql = yield* SqlClient
  yield* sql`ALTER TABLE rika_threads ADD COLUMN lineage_json TEXT NOT NULL DEFAULT '{"_tag":"Original"}'`
  yield* sql`ALTER TABLE rika_turns ADD COLUMN author_json TEXT NOT NULL DEFAULT '{"_tag":"Human"}'`
  yield* sql`ALTER TABLE rika_turns ADD COLUMN lineage_json TEXT NOT NULL DEFAULT '{"_tag":"Original"}'`
  yield* sql`CREATE TABLE rika_thread_relationships (
    id TEXT PRIMARY KEY NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('created', 'message', 'reply', 'fork')),
    source_thread_id TEXT NOT NULL,
    source_turn_id TEXT,
    target_thread_id TEXT NOT NULL,
    target_turn_id TEXT,
    created_at INTEGER NOT NULL,
    CHECK (source_thread_id <> target_thread_id OR kind <> 'message')
  )`
  yield* sql`CREATE UNIQUE INDEX rika_thread_relationship_identity ON rika_thread_relationships
    (kind, source_thread_id, COALESCE(source_turn_id, ''), target_thread_id, COALESCE(target_turn_id, ''))`
  yield* sql`CREATE TABLE rika_thread_invocation_receipts (
    invocation_digest TEXT PRIMARY KEY NOT NULL,
    schema_input_digest TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('create', 'message', 'steer', 'cancel', 'stop')),
    outcome TEXT NOT NULL,
    source_thread_id TEXT NOT NULL,
    source_root_turn_id TEXT,
    target_thread_id TEXT,
    target_turn_id TEXT,
    queue_revision INTEGER CHECK (queue_revision IS NULL OR queue_revision >= 0),
    created_at INTEGER NOT NULL
  )`
  yield* sql`CREATE INDEX rika_thread_invocation_source_root ON rika_thread_invocation_receipts
    (source_thread_id, source_root_turn_id, kind)`
  yield* sql`CREATE TABLE rika_thread_result_routes (
    id TEXT PRIMARY KEY NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('manual', 'reply')),
    source_thread_id TEXT,
    source_turn_id TEXT,
    target_thread_id TEXT NOT NULL,
    target_turn_id TEXT NOT NULL,
    delivery TEXT NOT NULL CHECK (delivery IN ('awaiting-result', 'ready', 'delivered', 'source-unavailable')),
    ready_sequence INTEGER CHECK (ready_sequence IS NULL OR ready_sequence >= 0),
    delivered_turn_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK ((kind = 'manual' AND source_thread_id IS NULL AND source_turn_id IS NULL) OR
      (kind = 'reply' AND source_thread_id IS NOT NULL AND source_turn_id IS NOT NULL)),
    CHECK ((delivery = 'delivered' AND delivered_turn_id IS NOT NULL) OR delivery <> 'delivered'),
    UNIQUE (target_turn_id)
  )`
  yield* sql`CREATE INDEX rika_thread_result_ready ON rika_thread_result_routes
    (delivery, ready_sequence, created_at, id)`
  yield* sql`CREATE TABLE rika_thread_root_readiness (
    turn_id TEXT PRIMARY KEY NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('WaitingReady', 'TerminalReady', 'CancelledBeforeStartReady')),
    cursor TEXT,
    sequence INTEGER CHECK (sequence IS NULL OR sequence >= 0),
    output TEXT,
    backfill INTEGER NOT NULL DEFAULT 0 CHECK (backfill IN (0, 1)),
    updated_at INTEGER NOT NULL,
    CHECK ((state = 'WaitingReady' AND cursor IS NOT NULL) OR state <> 'WaitingReady')
  )`
})

