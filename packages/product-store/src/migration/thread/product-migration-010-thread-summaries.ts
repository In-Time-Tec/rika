import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"

export const migration010 = Effect.gen(function* () {
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
