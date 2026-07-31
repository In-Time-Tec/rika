import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"

export const migration025 = Effect.gen(function* () {
  const sql = yield* SqlClient
  yield* sql`DROP TABLE rika_transcript_entries`
  yield* sql`DROP TABLE rika_transcript_units`
  yield* sql`CREATE TABLE rika_transcript_units (
    turn_id TEXT NOT NULL REFERENCES rika_turns(id) ON DELETE CASCADE,
    unit_key TEXT NOT NULL,
    execution_key TEXT COLLATE BINARY NOT NULL CHECK (length(execution_key) > 0),
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
  yield* sql`CREATE INDEX rika_transcript_units_page ON rika_transcript_units (
    thread_id, created_at DESC, turn_id DESC, unit_order_key DESC
  )`
  yield* sql`CREATE INDEX rika_transcript_units_turn ON rika_transcript_units (
    turn_id, unit_order_key ASC
  )`
  yield* sql`CREATE TABLE rika_transcript_checkpoints_next (
    turn_id TEXT PRIMARY KEY NOT NULL REFERENCES rika_turns(id) ON DELETE CASCADE,
    thread_id TEXT NOT NULL REFERENCES rika_threads(id) ON DELETE CASCADE,
    checkpoint_generation INTEGER NOT NULL DEFAULT 0 CHECK (checkpoint_generation >= 0),
    revision INTEGER NOT NULL DEFAULT -1 CHECK (revision >= -1),
    projection_version INTEGER NOT NULL DEFAULT 1 CHECK (projection_version >= 1),
    model_phase INTEGER NOT NULL DEFAULT -1 CHECK (model_phase >= -1),
    usable_completion_sequence INTEGER CHECK (
      usable_completion_sequence IS NULL OR usable_completion_sequence >= 0
    ),
    oldest_cursor TEXT,
    checkpoint_cursor TEXT,
    cost_usd REAL CHECK (cost_usd IS NULL OR cost_usd >= 0),
    usage_cursors_json TEXT,
    pricing_version TEXT,
    updated_at INTEGER NOT NULL
  )`
  yield* sql`INSERT INTO rika_transcript_checkpoints_next (
    turn_id, thread_id, checkpoint_generation, revision, projection_version, model_phase, updated_at
  )
  SELECT turn_id, thread_id, projection_generation, revision, 2, -1, updated_at
  FROM rika_transcript_checkpoints`
  yield* sql`DROP TABLE rika_transcript_checkpoints`
  yield* sql`ALTER TABLE rika_transcript_checkpoints_next RENAME TO rika_transcript_checkpoints`
  yield* sql`CREATE TABLE rika_transcript_execution_checkpoints (
    turn_id TEXT NOT NULL REFERENCES rika_transcript_checkpoints(turn_id) ON DELETE CASCADE,
    execution_key TEXT COLLATE BINARY NOT NULL CHECK (length(execution_key) > 0),
    execution_id TEXT NOT NULL CHECK (length(execution_id) > 0),
    cursor TEXT NOT NULL,
    sequence INTEGER NOT NULL CHECK (sequence >= -1),
    status TEXT CHECK (status IS NULL OR status IN ('completed', 'failed', 'cancelled')),
    revision INTEGER NOT NULL CHECK (revision >= -1),
    model_phase INTEGER NOT NULL CHECK (model_phase >= -1),
    usable_completion_sequence INTEGER CHECK (
      usable_completion_sequence IS NULL OR usable_completion_sequence >= 0
    ),
    oldest_cursor TEXT,
    checkpoint_cursor TEXT,
    cost_usd REAL CHECK (cost_usd IS NULL OR cost_usd >= 0),
    usage_cursors_json TEXT,
    pricing_version TEXT,
    parent_execution_key TEXT COLLATE BINARY,
    parent_unit_key TEXT,
    parent_id TEXT,
    parent_order_key TEXT COLLATE BINARY,
    is_root INTEGER NOT NULL CHECK (is_root IN (0, 1)),
    CHECK (revision = sequence),
    CHECK (coalesce(checkpoint_cursor, '') = cursor),
    CHECK (
      (is_root = 1 AND parent_execution_key IS NULL AND parent_unit_key IS NULL AND parent_id IS NULL AND parent_order_key IS NULL)
      OR
      (is_root = 0 AND parent_execution_key IS NOT NULL AND parent_unit_key IS NOT NULL AND parent_id IS NOT NULL AND parent_order_key IS NOT NULL)
    ),
    PRIMARY KEY (turn_id, execution_key),
    FOREIGN KEY (turn_id, parent_execution_key)
      REFERENCES rika_transcript_execution_checkpoints(turn_id, execution_key)
      DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (turn_id, parent_unit_key, parent_execution_key, parent_order_key, parent_id)
      REFERENCES rika_transcript_units(turn_id, unit_key, execution_key, unit_order_key, tool_id)
      DEFERRABLE INITIALLY DEFERRED
  )`
  yield* sql`DROP TABLE rika_thread_root_readiness`
  yield* sql`DROP TABLE rika_thread_result_routes`
  yield* sql`CREATE TABLE rika_thread_result_routes (
    id TEXT PRIMARY KEY NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('manual', 'reply')),
    source_thread_id TEXT REFERENCES rika_threads(id) ON DELETE CASCADE,
    source_turn_id TEXT REFERENCES rika_turns(id) ON DELETE CASCADE,
    target_thread_id TEXT NOT NULL REFERENCES rika_threads(id) ON DELETE CASCADE,
    target_turn_id TEXT NOT NULL REFERENCES rika_turns(id) ON DELETE CASCADE,
    delivery TEXT NOT NULL CHECK (
      delivery IN ('awaiting-result', 'ready', 'delivered', 'failed', 'cancelled', 'source-unavailable')
    ),
    ready_sequence INTEGER CHECK (ready_sequence IS NULL OR ready_sequence >= 0),
    delivered_turn_id TEXT REFERENCES rika_turns(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK ((kind = 'manual' AND source_thread_id IS NULL AND source_turn_id IS NULL) OR
      (kind = 'reply' AND source_thread_id IS NOT NULL AND source_turn_id IS NOT NULL)),
    CHECK (
      (delivery IN ('awaiting-result', 'failed', 'cancelled') AND ready_sequence IS NULL AND delivered_turn_id IS NULL)
      OR (delivery IN ('ready', 'source-unavailable') AND ready_sequence IS NOT NULL AND delivered_turn_id IS NULL)
      OR (delivery = 'delivered' AND ready_sequence IS NOT NULL AND delivered_turn_id IS NOT NULL)
    ),
    UNIQUE (target_turn_id)
  )`
  yield* sql`CREATE INDEX rika_thread_result_ready ON rika_thread_result_routes
    (delivery, ready_sequence, created_at, id)`
  yield* sql`CREATE TABLE rika_thread_root_results (
    turn_id TEXT PRIMARY KEY NOT NULL REFERENCES rika_turns(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN ('completed', 'failed', 'cancelled')),
    cursor TEXT,
    sequence INTEGER CHECK (sequence IS NULL OR sequence >= 0),
    output TEXT,
    reason TEXT,
    updated_at INTEGER NOT NULL,
    CHECK (
      (status = 'completed' AND cursor IS NOT NULL AND sequence IS NOT NULL AND output IS NOT NULL AND reason IS NULL)
      OR (status = 'failed' AND cursor IS NOT NULL AND sequence IS NOT NULL AND output IS NULL)
      OR (status = 'cancelled' AND output IS NULL AND ((cursor IS NULL AND sequence IS NULL) OR (cursor IS NOT NULL AND sequence IS NOT NULL)))
    )
  )`
})

