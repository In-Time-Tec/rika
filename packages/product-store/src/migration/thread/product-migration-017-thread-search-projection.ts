import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"

export const migration017 = Effect.gen(function* () {
  const sql = yield* SqlClient
  yield* sql`CREATE VIRTUAL TABLE rika_thread_search USING fts5(
    thread_id UNINDEXED,
    title,
    labels,
    human_prompts,
    agent_prompts,
    root_assistant,
    child_assistant,
    files,
    tokenize = 'unicode61'
  )`
  yield* sql`CREATE TABLE rika_thread_search_files (
    thread_id TEXT NOT NULL REFERENCES rika_threads(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    PRIMARY KEY (thread_id, path)
  )`
  yield* sql`CREATE INDEX rika_thread_search_files_path ON rika_thread_search_files (path, thread_id)`
  yield* sql`INSERT INTO rika_thread_search (
    thread_id, title, labels, human_prompts, agent_prompts, root_assistant, child_assistant, files
  )
  SELECT t.id, t.title, t.labels_json,
    COALESCE((SELECT group_concat(prompt, char(10)) FROM rika_turns WHERE thread_id = t.id), ''),
    '', '', '', ''
  FROM rika_threads t`
})

