import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"

export const migration023 = Effect.gen(function* () {
  const sql = yield* SqlClient
  yield* sql`CREATE TABLE rika_transcript_checkpoints_next (
    turn_id TEXT PRIMARY KEY NOT NULL REFERENCES rika_turns(id) ON DELETE CASCADE,
    thread_id TEXT NOT NULL REFERENCES rika_threads(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL DEFAULT -1,
    projection_version INTEGER NOT NULL DEFAULT 1 CHECK (projection_version >= 1),
    model_phase INTEGER NOT NULL DEFAULT -1,
    oldest_cursor TEXT,
    checkpoint_cursor TEXT,
    cost_usd REAL,
    usage_cursors_json TEXT,
    consumed_json TEXT,
    pricing_version TEXT,
    child_tree_reconciled INTEGER NOT NULL DEFAULT 0 CHECK (child_tree_reconciled IN (0, 1)),
    projection_generation INTEGER NOT NULL DEFAULT 0 CHECK (projection_generation >= 0),
    updated_at INTEGER NOT NULL
  )`
  yield* sql`INSERT INTO rika_transcript_checkpoints_next (
    turn_id, thread_id, revision, projection_version, model_phase, oldest_cursor, checkpoint_cursor,
    cost_usd, usage_cursors_json, consumed_json, pricing_version, child_tree_reconciled,
    projection_generation, updated_at
  )
  SELECT turn_id, thread_id, revision, 1, model_phase, oldest_cursor, checkpoint_cursor,
    cost_usd, usage_cursors_json, NULL, pricing_version, child_tree_reconciled,
    projection_generation, updated_at
  FROM rika_transcript_checkpoints`
  yield* sql`DROP TABLE rika_transcript_checkpoints`
  yield* sql`ALTER TABLE rika_transcript_checkpoints_next RENAME TO rika_transcript_checkpoints`
})

