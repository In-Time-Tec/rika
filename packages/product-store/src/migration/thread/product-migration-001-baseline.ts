import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"

export const migration001 = Effect.gen(function* () {
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
