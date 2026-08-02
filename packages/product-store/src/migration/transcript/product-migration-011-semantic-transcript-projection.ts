import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"

export const migration011 = Effect.gen(function* () {
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
