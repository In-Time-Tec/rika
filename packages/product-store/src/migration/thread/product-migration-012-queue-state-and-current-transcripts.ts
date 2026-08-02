import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"

const legacyExecutionRoute = JSON.stringify({
  version: 1,
  mode: "test",
  main: {
    role: "main",
    alias: "legacy-unavailable",
    provider: "legacy-unavailable",
    model: "legacy-unavailable",
    registrationKey: "legacy-unavailable",
    gatewayProtocol: "test",
    gatewayBaseUrl: "test://legacy-unavailable",
    gatewayAuth: "none",
    effort: "medium",
    fast: false,
    requestVariant: "legacy-unavailable",
    compaction: { contextWindow: 1, reserveTokens: 0, keepRecentTokens: 0 },
  },
  oracle: {
    role: "oracle",
    alias: "legacy-unavailable",
    provider: "legacy-unavailable",
    model: "legacy-unavailable",
    registrationKey: "legacy-unavailable",
    gatewayProtocol: "test",
    gatewayBaseUrl: "test://legacy-unavailable",
    gatewayAuth: "none",
    effort: "medium",
    fast: false,
    requestVariant: "legacy-unavailable",
    compaction: { contextWindow: 1, reserveTokens: 0, keepRecentTokens: 0 },
  },
})

export const migration012 = Effect.gen(function* () {
  const sql = yield* SqlClient
  yield* sql`UPDATE rika_turns SET execution_route_json = ${legacyExecutionRoute} WHERE execution_route_json IS NULL`
  yield* sql`ALTER TABLE rika_transcript_checkpoints ADD COLUMN model_phase INTEGER NOT NULL DEFAULT -1`
  yield* sql`CREATE INDEX rika_turns_queue ON rika_turns (thread_id, status, created_at ASC, id ASC)`
  yield* sql`CREATE TABLE rika_thread_queue_state (
    thread_id TEXT NOT NULL REFERENCES rika_threads(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
    queued_count INTEGER NOT NULL DEFAULT 0 CHECK (queued_count >= 0),
    wake_generation INTEGER NOT NULL DEFAULT 0 CHECK (wake_generation >= 0),
    wake_pending INTEGER NOT NULL DEFAULT 0 CHECK (wake_pending IN (0, 1)),
    PRIMARY KEY (thread_id)
  )`
  yield* sql`INSERT INTO rika_thread_queue_state (thread_id, revision, queued_count)
    SELECT thread_id, COUNT(*), COUNT(*)
    FROM rika_turns
    WHERE status = 'queued'
    GROUP BY thread_id`
})
