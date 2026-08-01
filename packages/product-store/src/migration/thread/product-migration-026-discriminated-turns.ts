import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"

export const migration026 = Effect.gen(function* () {
  const sql = yield* SqlClient
  yield* sql`ALTER TABLE rika_turns ADD COLUMN shell_command TEXT`
  yield* sql`ALTER TABLE rika_turns ADD COLUMN shell_result_text TEXT`
  yield* sql`ALTER TABLE rika_turns ADD COLUMN shell_result_truncated INTEGER`
  yield* sql`ALTER TABLE rika_turns ADD COLUMN shell_result_exit_code INTEGER`
  yield* sql`ALTER TABLE rika_turns ADD COLUMN turn_kind TEXT NOT NULL DEFAULT 'AgentExecution'
    CHECK (
      (
        turn_kind = 'AgentExecution'
        AND execution_route_json IS NOT NULL
        AND shell_command IS NULL
        AND shell_result_text IS NULL
        AND shell_result_truncated IS NULL
        AND shell_result_exit_code IS NULL
      )
      OR
      (
        turn_kind = 'RecordedShell'
        AND shell_command IS NOT NULL
        AND length(shell_command) > 0
        AND prompt = '$ ' || shell_command
        AND prompt_parts_json IS NULL
        AND execution_route_json IS NULL
        AND last_cursor IS NULL
        AND extension_pin_json IS NULL
        AND review_fan_out_id IS NULL
        AND queue_claim_token IS NULL
        AND stop_intent = 'none'
        AND author_json = '{"_tag":"Human"}'
        AND lineage_json = '{"_tag":"Original"}'
        AND status IN ('running', 'completed', 'failed', 'cancelled')
        AND (
          (
            status = 'running'
            AND shell_result_text IS NULL
            AND shell_result_truncated IS NULL
            AND shell_result_exit_code IS NULL
          )
          OR
          (
            status IN ('completed', 'failed', 'cancelled')
            AND shell_result_text IS NOT NULL
            AND shell_result_truncated IN (0, 1)
            AND (shell_result_exit_code IS NULL OR typeof(shell_result_exit_code) = 'integer')
          )
        )
      )
    )`
  yield* sql`PRAGMA defer_foreign_keys = ON`
  yield* sql`DROP INDEX rika_transcript_units_page`
  yield* sql`DROP INDEX rika_transcript_units_turn`
  yield* sql`CREATE TABLE rika_transcript_units_next (
    turn_id TEXT NOT NULL REFERENCES rika_turns(id) ON DELETE CASCADE,
    unit_key TEXT NOT NULL,
    execution_key TEXT COLLATE BINARY CHECK (execution_key IS NULL OR length(execution_key) > 0),
    thread_id TEXT NOT NULL REFERENCES rika_threads(id) ON DELETE CASCADE,
    unit_order_key TEXT COLLATE BINARY NOT NULL,
    tool_id TEXT,
    parent_id TEXT,
    revision INTEGER NOT NULL,
    unit_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (turn_id, unit_key),
    UNIQUE (turn_id, unit_order_key),
    UNIQUE (turn_id, unit_key, execution_key, unit_order_key, tool_id),
    FOREIGN KEY (turn_id, execution_key)
      REFERENCES rika_transcript_execution_checkpoints(turn_id, execution_key)
      ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
  )`
  yield* sql`INSERT INTO rika_transcript_units_next (
      turn_id, unit_key, execution_key, thread_id, unit_order_key, tool_id,
      parent_id, revision, unit_json, created_at, updated_at
    ) SELECT
      turn_id, unit_key, execution_key, thread_id, unit_order_key, tool_id,
      parent_id, revision, unit_json, created_at, updated_at
    FROM rika_transcript_units`
  yield* sql`DROP TABLE rika_transcript_units`
  yield* sql`ALTER TABLE rika_transcript_units_next RENAME TO rika_transcript_units`
  yield* sql`CREATE INDEX rika_transcript_units_page ON rika_transcript_units (
    thread_id, created_at DESC, turn_id DESC, unit_order_key DESC
  )`
  yield* sql`CREATE INDEX rika_transcript_units_turn ON rika_transcript_units (
    turn_id, unit_order_key ASC
  )`
})

