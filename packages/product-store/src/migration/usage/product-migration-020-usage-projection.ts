import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"

export const migration020 = Effect.gen(function* () {
  const sql = yield* SqlClient
  yield* sql`CREATE TABLE rika_turn_usage (
    turn_id TEXT PRIMARY KEY NOT NULL REFERENCES rika_turns(id) ON DELETE CASCADE,
    thread_id TEXT NOT NULL REFERENCES rika_threads(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
    projection_version INTEGER NOT NULL DEFAULT 1,
    fold_json TEXT,
    cost_nano_usd INTEGER CHECK (cost_nano_usd IS NULL OR cost_nano_usd >= 0),
    tokens INTEGER CHECK (tokens IS NULL OR tokens >= 0),
    active_millis INTEGER CHECK (active_millis IS NULL OR active_millis >= 0),
    active_intervals_json TEXT,
    priced_attempts INTEGER NOT NULL DEFAULT 0 CHECK (priced_attempts >= 0),
    unpriced_attempts INTEGER NOT NULL DEFAULT 0 CHECK (unpriced_attempts >= 0),
    counted_attempts INTEGER NOT NULL DEFAULT 0 CHECK (counted_attempts >= 0),
    uncounted_attempts INTEGER NOT NULL DEFAULT 0 CHECK (uncounted_attempts >= 0),
    source_complete INTEGER NOT NULL DEFAULT 0 CHECK (source_complete IN (0, 1)),
    updated_at INTEGER NOT NULL
  )`
  yield* sql`CREATE INDEX rika_turn_usage_thread ON rika_turn_usage (thread_id, turn_id)`
  yield* sql`CREATE TABLE rika_usage_repairs (
    turn_id TEXT PRIMARY KEY NOT NULL REFERENCES rika_turns(id) ON DELETE CASCADE,
    claim_token TEXT,
    checkpoint_json TEXT,
    updated_at INTEGER NOT NULL
  )`
  yield* sql`INSERT INTO rika_turn_usage (
    turn_id, thread_id, cost_nano_usd, source_complete, updated_at
  )
  SELECT t.id, t.thread_id,
    NULL,
    0, t.updated_at
  FROM rika_turns t
  WHERE t.status <> 'queued'`
})

