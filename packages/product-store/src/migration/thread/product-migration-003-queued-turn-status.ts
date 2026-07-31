import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"

export const migration003 = Effect.gen(function* () {
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

