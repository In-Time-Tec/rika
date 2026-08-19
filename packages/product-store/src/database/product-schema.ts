import { Effect, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import type { SqlError } from "effect/unstable/sql/SqlError"

export interface SchemaObject {
  readonly type: string
  readonly name: string
  readonly table_name: string
  readonly sql: string | null
}

export const schemaFingerprint = (objects: ReadonlyArray<SchemaObject>): string =>
  JSON.stringify(
    objects
      .filter(({ name }) => name !== "rika_schema_identity")
      .map(({ type, name, table_name, sql }) => [type, name, table_name, sql])
      .toSorted((left, right) => String(left[1]).localeCompare(String(right[1]))),
  )

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const UnknownJson = Schema.fromJsonString(Schema.Unknown)
const decodeJson = Schema.decodeUnknownSync(UnknownJson)
const encodeJson = Schema.encodeSync(UnknownJson)

const migrateExecutionRouteModel = (value: unknown): void => {
  if (!isRecord(value)) return
  if (Object.hasOwn(value, "alias")) {
    value.selection = value.alias
    delete value.alias
  }
  if (!Array.isArray(value.candidates)) return
  for (const candidate of value.candidates) {
    if (!isRecord(candidate) || !isRecord(candidate.providerConnection)) continue
    if (candidate.providerConnection.protocol === "openai") candidate.providerConnection.protocol = "openai-responses"
  }
}

const migrateExecutionRoute = (value: unknown): boolean => {
  if (!isRecord(value) || (value.version !== 1 && value.version !== 2)) return false
  value.version = 3
  if (!Object.hasOwn(value, "subagents")) value.subagents = { maxDepth: 1, maxSubagents: 4 }
  for (const key of ["main", "oracle", "title", "compactionSummary"]) migrateExecutionRouteModel(value[key])
  if (isRecord(value.agents))
    for (const key of ["librarian", "painter", "readThread", "review", "surgeon", "task"])
      migrateExecutionRouteModel(value.agents[key])
  return true
}

const migrateExecutionRouteJson = (serialized: string, path: ReadonlyArray<string>): string | undefined => {
  const document = decodeJson(serialized)
  let value = document
  for (const key of path) {
    if (!isRecord(value)) return undefined
    value = value[key]
  }
  return migrateExecutionRoute(value) ? encodeJson(document) : undefined
}

export const create = Effect.gen(function* () {
  const sql = yield* SqlClient
  yield* sql`CREATE TABLE rika_workspaces (
    path TEXT PRIMARY KEY NOT NULL,
    created_at INTEGER NOT NULL
  )`
  yield* sql`CREATE TABLE rika_threads (
    id TEXT PRIMARY KEY NOT NULL,
    workspace TEXT NOT NULL REFERENCES rika_workspaces(path),
    title TEXT NOT NULL,
    labels_json TEXT NOT NULL DEFAULT '[]',
    pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
    archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
    lineage_json TEXT NOT NULL DEFAULT '{"_tag":"Original"}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`
  yield* sql`CREATE INDEX rika_threads_listing ON rika_threads (pinned DESC, updated_at DESC, id ASC)`
  yield* sql`CREATE TABLE rika_thread_deletion_outbox (
    thread_id TEXT PRIMARY KEY NOT NULL REFERENCES rika_threads(id) ON DELETE CASCADE,
    requested_at INTEGER NOT NULL
  )`
  yield* sql`CREATE TABLE rika_turns (
    id TEXT PRIMARY KEY NOT NULL,
    thread_id TEXT NOT NULL REFERENCES rika_threads(id) ON DELETE CASCADE,
    prompt TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('accepted', 'queued', 'running', 'waiting', 'cancelling', 'completed', 'failed', 'cancelled')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    prompt_parts_json TEXT,
    execution_route_json TEXT,
    execution_link_json TEXT,
    queue_claim_token TEXT,
    author_json TEXT NOT NULL DEFAULT '{"_tag":"Human"}',
    lineage_json TEXT NOT NULL DEFAULT '{"_tag":"Original"}',
    shell_command TEXT,
    shell_result_text TEXT,
    shell_result_truncated INTEGER,
    shell_result_exit_code INTEGER,
    turn_kind TEXT NOT NULL DEFAULT 'AgentExecution'
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
          AND execution_link_json IS NULL
          AND queue_claim_token IS NULL
          AND author_json = '{"_tag":"Human"}'
          AND lineage_json = '{"_tag":"Original"}'
          AND status IN ('running', 'completed', 'failed', 'cancelled')
          AND (
            (status = 'running' AND shell_result_text IS NULL AND shell_result_truncated IS NULL AND shell_result_exit_code IS NULL)
            OR
            (status IN ('completed', 'failed', 'cancelled') AND shell_result_text IS NOT NULL AND shell_result_truncated IN (0, 1) AND (shell_result_exit_code IS NULL OR typeof(shell_result_exit_code) = 'integer'))
          )
        )
      )
  )`
  yield* sql`CREATE INDEX rika_turns_thread ON rika_turns (thread_id, created_at ASC, id ASC)`
  yield* sql`CREATE INDEX rika_turns_queue ON rika_turns (thread_id, status, created_at ASC, id ASC)`
  yield* sql`CREATE UNIQUE INDEX rika_turns_queue_claim ON rika_turns (thread_id) WHERE queue_claim_token IS NOT NULL`
  yield* sql`CREATE INDEX rika_turns_thread_updated ON rika_turns (thread_id, updated_at DESC)`
  yield* sql`CREATE INDEX rika_turns_thread_nonqueued ON rika_turns (thread_id, created_at DESC, id DESC)
    WHERE status <> 'queued'`
  yield* sql`CREATE TRIGGER rika_tombstoned_thread_turn_insert
    BEFORE INSERT ON rika_turns
    WHEN EXISTS (SELECT 1 FROM rika_thread_deletion_outbox WHERE thread_id = NEW.thread_id) BEGIN
      SELECT RAISE(ABORT, 'thread deletion is pending');
    END`
  yield* sql`CREATE TABLE rika_turn_admission_outbox (
    turn_id TEXT PRIMARY KEY NOT NULL REFERENCES rika_turns(id) ON DELETE CASCADE,
    start_input_json TEXT NOT NULL,
    prepared_at INTEGER NOT NULL
  )`
  yield* sql`CREATE TABLE rika_turn_steering_outbox (
    request_id TEXT PRIMARY KEY NOT NULL,
    target_turn_id TEXT NOT NULL REFERENCES rika_turns(id) ON DELETE CASCADE,
    source_turn_id TEXT UNIQUE,
    thread_id TEXT NOT NULL REFERENCES rika_threads(id) ON DELETE CASCADE,
    admission_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'rejected')),
    prepared_at INTEGER NOT NULL
  )`
  yield* sql`CREATE TABLE rika_thread_queue_state (
    thread_id TEXT PRIMARY KEY NOT NULL REFERENCES rika_threads(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
    queued_count INTEGER NOT NULL DEFAULT 0 CHECK (queued_count >= 0)
  )`
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
  yield* sql`CREATE TABLE rika_goals (
    thread_id TEXT PRIMARY KEY NOT NULL REFERENCES rika_threads(id) ON DELETE CASCADE,
    objective TEXT NOT NULL CHECK (length(objective) > 0 AND length(objective) <= 4096),
    status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'complete', 'errored')),
    budget_tokens INTEGER CHECK (budget_tokens IS NULL OR budget_tokens > 0),
    budget_wall_clock_millis INTEGER CHECK (budget_wall_clock_millis IS NULL OR budget_wall_clock_millis > 0),
    usage_tokens INTEGER NOT NULL DEFAULT 0 CHECK (usage_tokens >= 0),
    usage_elapsed_millis INTEGER NOT NULL DEFAULT 0 CHECK (usage_elapsed_millis >= 0),
    usage_turns INTEGER NOT NULL DEFAULT 0 CHECK (usage_turns >= 0),
    started_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    completed_at INTEGER,
    summary TEXT,
    CHECK ((status = 'complete') = (completed_at IS NOT NULL))
  )`
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
  yield* sql`CREATE TABLE rika_transcript_checkpoints (
    turn_id TEXT PRIMARY KEY NOT NULL REFERENCES rika_turns(id) ON DELETE CASCADE,
    thread_id TEXT NOT NULL REFERENCES rika_threads(id) ON DELETE CASCADE,
    checkpoint_generation INTEGER NOT NULL DEFAULT 0 CHECK (checkpoint_generation >= 0),
    revision INTEGER NOT NULL DEFAULT -1 CHECK (revision >= -1),
    projection_version INTEGER NOT NULL DEFAULT 1 CHECK (projection_version >= 1),
    state_json TEXT NOT NULL,
    projector_version INTEGER CHECK (projector_version IS NULL OR projector_version >= 1),
    projector_cursor TEXT,
    projector_state TEXT,
    updated_at INTEGER NOT NULL,
    CHECK (
      (projector_version IS NULL AND projector_cursor IS NULL AND projector_state IS NULL)
      OR
      (projector_version IS NOT NULL AND projector_cursor IS NOT NULL AND projector_state IS NOT NULL)
    )
  )`
  yield* sql`CREATE TABLE rika_transcript_units (
    turn_id TEXT NOT NULL REFERENCES rika_turns(id) ON DELETE CASCADE,
    unit_key TEXT NOT NULL,
    thread_id TEXT NOT NULL REFERENCES rika_threads(id) ON DELETE CASCADE,
    unit_order_key TEXT COLLATE BINARY NOT NULL,
    parent_id TEXT,
    revision INTEGER NOT NULL,
    unit_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (turn_id, unit_key),
    UNIQUE (turn_id, unit_order_key)
  )`
  yield* sql`CREATE INDEX rika_transcript_units_page ON rika_transcript_units (
    thread_id, created_at DESC, turn_id DESC, unit_order_key DESC
  )`
  yield* sql`CREATE INDEX rika_transcript_units_turn ON rika_transcript_units (turn_id, unit_order_key ASC)`
  yield* sql`CREATE TABLE rika_thread_picker_summary (
    thread_id TEXT PRIMARY KEY NOT NULL REFERENCES rika_threads(id) ON DELETE CASCADE,
    workspace TEXT NOT NULL,
    title TEXT NOT NULL,
    pinned INTEGER NOT NULL CHECK (pinned IN (0, 1)),
    archived INTEGER NOT NULL CHECK (archived IN (0, 1)),
    status_rank INTEGER NOT NULL,
    waiting_count INTEGER NOT NULL CHECK (waiting_count >= 0),
    running_count INTEGER NOT NULL CHECK (running_count >= 0),
    queued_count INTEGER NOT NULL CHECK (queued_count >= 0),
    last_status TEXT,
    last_turn_created_at INTEGER,
    last_turn_id TEXT,
    last_activity_at INTEGER NOT NULL,
    turn_count INTEGER NOT NULL CHECK (turn_count >= 0),
    current_activity_count INTEGER NOT NULL CHECK (current_activity_count >= 0),
    added INTEGER NOT NULL CHECK (added >= 0),
    modified INTEGER NOT NULL CHECK (modified >= 0),
    removed INTEGER NOT NULL CHECK (removed >= 0)
  )`
  yield* sql`CREATE INDEX rika_thread_picker_summary_listing ON rika_thread_picker_summary (
    archived, pinned DESC, last_activity_at DESC, thread_id ASC
  )`
  yield* sql`CREATE TRIGGER rika_thread_picker_summary_thread_insert
    AFTER INSERT ON rika_threads BEGIN
      INSERT INTO rika_thread_picker_summary (
        thread_id, workspace, title, pinned, archived, status_rank, waiting_count, running_count, queued_count,
        last_activity_at, turn_count, current_activity_count, added, modified, removed
      ) VALUES (NEW.id, NEW.workspace, NEW.title, NEW.pinned, NEW.archived, 0, 0, 0, 0,
        NEW.created_at, 0, 0, 0, 0, 0);
    END`
  yield* sql`CREATE TRIGGER rika_thread_picker_summary_thread_update
    AFTER UPDATE OF workspace, title, pinned, archived ON rika_threads BEGIN
      UPDATE rika_thread_picker_summary SET workspace = NEW.workspace, title = NEW.title,
        pinned = NEW.pinned, archived = NEW.archived WHERE thread_id = NEW.id;
    END`
  yield* sql`CREATE TRIGGER rika_thread_picker_summary_turn_insert
    AFTER INSERT ON rika_turns BEGIN
      UPDATE rika_thread_picker_summary SET
        waiting_count = waiting_count + (NEW.status = 'waiting'),
        running_count = running_count + (NEW.status IN ('accepted', 'running', 'waiting', 'cancelling')),
        queued_count = queued_count + (NEW.status = 'queued'),
        status_rank = MAX(status_rank, CASE WHEN NEW.status = 'waiting' THEN 3
          WHEN NEW.status IN ('accepted', 'running', 'waiting', 'cancelling') THEN 2 WHEN NEW.status = 'queued' THEN 1 ELSE 0 END),
        last_status = CASE WHEN last_turn_created_at IS NULL OR (NEW.created_at, NEW.id) >
          (last_turn_created_at, last_turn_id) THEN NEW.status ELSE last_status END,
        last_turn_created_at = CASE WHEN last_turn_created_at IS NULL OR (NEW.created_at, NEW.id) >
          (last_turn_created_at, last_turn_id) THEN NEW.created_at ELSE last_turn_created_at END,
        last_turn_id = CASE WHEN last_turn_created_at IS NULL OR (NEW.created_at, NEW.id) >
          (last_turn_created_at, last_turn_id) THEN NEW.id ELSE last_turn_id END,
        last_activity_at = MAX(last_activity_at, NEW.updated_at),
        turn_count = turn_count + 1
      WHERE thread_id = NEW.thread_id;
    END`
  yield* sql`CREATE TRIGGER rika_thread_picker_summary_turn_update
    AFTER UPDATE OF status, updated_at ON rika_turns BEGIN
      UPDATE rika_thread_picker_summary SET
        waiting_count = waiting_count - (OLD.status = 'waiting') + (NEW.status = 'waiting'),
        running_count = running_count - (OLD.status IN ('accepted', 'running', 'waiting', 'cancelling')) + (NEW.status IN ('accepted', 'running', 'waiting', 'cancelling')),
        queued_count = queued_count - (OLD.status = 'queued') + (NEW.status = 'queued'),
        status_rank = CASE
          WHEN waiting_count - (OLD.status = 'waiting') + (NEW.status = 'waiting') > 0 THEN 3
          WHEN running_count - (OLD.status IN ('accepted', 'running', 'waiting', 'cancelling')) + (NEW.status IN ('accepted', 'running', 'waiting', 'cancelling')) > 0 THEN 2
          WHEN queued_count - (OLD.status = 'queued') + (NEW.status = 'queued') > 0 THEN 1 ELSE 0 END,
        last_status = CASE WHEN last_turn_id = NEW.id THEN NEW.status ELSE last_status END,
        last_activity_at = MAX(last_activity_at, NEW.updated_at),
        current_activity_count = current_activity_count + COALESCE((SELECT
          (NEW.status NOT IN ('completed', 'failed', 'cancelled') OR activity.complete = 1) -
          (OLD.status NOT IN ('completed', 'failed', 'cancelled') OR activity.complete = 1)
          FROM rika_thread_turn_activity AS activity WHERE activity.turn_id = NEW.id), 0)
      WHERE thread_id = NEW.thread_id;
    END`
  yield* sql`CREATE TRIGGER rika_thread_picker_summary_turn_before_delete
    BEFORE DELETE ON rika_turns BEGIN
      UPDATE rika_thread_picker_summary SET
        current_activity_count = current_activity_count - COALESCE((SELECT
          OLD.status NOT IN ('completed', 'failed', 'cancelled') OR activity.complete = 1
          FROM rika_thread_turn_activity AS activity WHERE activity.turn_id = OLD.id), 0),
        added = added - COALESCE((SELECT added FROM rika_thread_turn_activity WHERE turn_id = OLD.id), 0),
        modified = modified - COALESCE((SELECT modified FROM rika_thread_turn_activity WHERE turn_id = OLD.id), 0),
        removed = removed - COALESCE((SELECT removed FROM rika_thread_turn_activity WHERE turn_id = OLD.id), 0)
      WHERE thread_id = OLD.thread_id;
    END`
  yield* sql`CREATE TRIGGER rika_thread_picker_summary_turn_delete
    AFTER DELETE ON rika_turns BEGIN
      UPDATE rika_thread_picker_summary SET
        waiting_count = waiting_count - (OLD.status = 'waiting'),
        running_count = running_count - (OLD.status IN ('accepted', 'running', 'waiting', 'cancelling')),
        queued_count = queued_count - (OLD.status = 'queued'),
        status_rank = CASE WHEN waiting_count - (OLD.status = 'waiting') > 0 THEN 3
          WHEN running_count - (OLD.status IN ('accepted', 'running', 'waiting', 'cancelling')) > 0 THEN 2
          WHEN queued_count - (OLD.status = 'queued') > 0 THEN 1 ELSE 0 END,
        turn_count = turn_count - 1,
        last_status = CASE WHEN last_turn_id = OLD.id THEN (SELECT status FROM rika_turns WHERE thread_id = OLD.thread_id ORDER BY created_at DESC, id DESC LIMIT 1) ELSE last_status END,
        last_turn_created_at = CASE WHEN last_turn_id = OLD.id THEN (SELECT created_at FROM rika_turns WHERE thread_id = OLD.thread_id ORDER BY created_at DESC, id DESC LIMIT 1) ELSE last_turn_created_at END,
        last_turn_id = CASE WHEN last_turn_id = OLD.id THEN (SELECT id FROM rika_turns WHERE thread_id = OLD.thread_id ORDER BY created_at DESC, id DESC LIMIT 1) ELSE last_turn_id END,
        last_activity_at = MAX(
          (SELECT created_at FROM rika_threads WHERE id = OLD.thread_id),
          COALESCE((SELECT MAX(updated_at) FROM rika_turns WHERE thread_id = OLD.thread_id), 0),
          COALESCE((SELECT MAX(last_event_at) FROM rika_thread_turn_activity WHERE thread_id = OLD.thread_id), 0)
        )
      WHERE thread_id = OLD.thread_id;
    END`
  yield* sql`CREATE TRIGGER rika_thread_picker_summary_activity_insert
    AFTER INSERT ON rika_thread_turn_activity BEGIN
      UPDATE rika_thread_picker_summary SET
        current_activity_count = current_activity_count + COALESCE((SELECT
          turn.status NOT IN ('completed', 'failed', 'cancelled') OR NEW.complete = 1
          FROM rika_turns AS turn WHERE turn.id = NEW.turn_id), 0),
        added = added + NEW.added, modified = modified + NEW.modified, removed = removed + NEW.removed,
        last_activity_at = MAX(last_activity_at, COALESCE(NEW.last_event_at, last_activity_at))
      WHERE thread_id = NEW.thread_id;
    END`
  yield* sql`CREATE TRIGGER rika_thread_picker_summary_activity_update
    AFTER UPDATE OF complete, added, modified, removed, last_event_at ON rika_thread_turn_activity BEGIN
      UPDATE rika_thread_picker_summary SET
        current_activity_count = current_activity_count + COALESCE((SELECT
          (turn.status NOT IN ('completed', 'failed', 'cancelled') OR NEW.complete = 1) -
          (turn.status NOT IN ('completed', 'failed', 'cancelled') OR OLD.complete = 1)
          FROM rika_turns AS turn WHERE turn.id = NEW.turn_id), 0),
        added = added - OLD.added + NEW.added,
        modified = modified - OLD.modified + NEW.modified,
        removed = removed - OLD.removed + NEW.removed,
        last_activity_at = CASE WHEN OLD.last_event_at = last_activity_at AND
          COALESCE(NEW.last_event_at, 0) < OLD.last_event_at THEN MAX(
            (SELECT created_at FROM rika_threads WHERE id = NEW.thread_id),
            COALESCE((SELECT MAX(updated_at) FROM rika_turns WHERE thread_id = NEW.thread_id), 0),
            COALESCE((SELECT MAX(last_event_at) FROM rika_thread_turn_activity WHERE thread_id = NEW.thread_id), 0)
          ) ELSE MAX(last_activity_at, COALESCE(NEW.last_event_at, last_activity_at)) END
      WHERE thread_id = NEW.thread_id;
    END`
  yield* sql`CREATE TRIGGER rika_thread_picker_summary_activity_delete
    AFTER DELETE ON rika_thread_turn_activity
    WHEN EXISTS (SELECT 1 FROM rika_turns WHERE id = OLD.turn_id) BEGIN
      UPDATE rika_thread_picker_summary SET
        current_activity_count = current_activity_count - COALESCE((SELECT
          turn.status NOT IN ('completed', 'failed', 'cancelled') OR OLD.complete = 1
          FROM rika_turns AS turn WHERE turn.id = OLD.turn_id), 0),
        added = added - OLD.added, modified = modified - OLD.modified, removed = removed - OLD.removed,
        last_activity_at = CASE WHEN OLD.last_event_at = last_activity_at THEN MAX(
          (SELECT created_at FROM rika_threads WHERE id = OLD.thread_id),
          COALESCE((SELECT MAX(updated_at) FROM rika_turns WHERE thread_id = OLD.thread_id), 0),
          COALESCE((SELECT MAX(last_event_at) FROM rika_thread_turn_activity WHERE thread_id = OLD.thread_id), 0)
        ) ELSE last_activity_at END
      WHERE thread_id = OLD.thread_id;
    END`
  yield* sql`CREATE TABLE rika_execution_route_contract (
    id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
    version INTEGER NOT NULL CHECK (version = 3)
  )`
  yield* sql`INSERT INTO rika_execution_route_contract (id, version) VALUES (1, 3)`
  yield* sql`CREATE TABLE rika_schema_identity (
    id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
    fingerprint TEXT NOT NULL
  )`
  const objects = yield* sql<SchemaObject>`SELECT type, name, tbl_name AS table_name, sql
    FROM sqlite_schema
    WHERE type IN ('table', 'index', 'trigger', 'view') AND name NOT LIKE 'sqlite_%'
    ORDER BY name ASC`
  yield* sql`INSERT INTO rika_schema_identity (id, fingerprint) VALUES (1, ${schemaFingerprint(objects)})`
})

export const schemaObjects: ReadonlyArray<string> = [
  "table:rika_workspaces",
  "table:rika_threads",
  "index:rika_threads_listing",
  "table:rika_thread_deletion_outbox",
  "table:rika_turns",
  "index:rika_turns_thread",
  "index:rika_turns_queue",
  "index:rika_turns_queue_claim",
  "index:rika_turns_thread_updated",
  "index:rika_turns_thread_nonqueued",
  "trigger:rika_tombstoned_thread_turn_insert",
  "table:rika_turn_admission_outbox",
  "table:rika_turn_steering_outbox",
  "table:rika_thread_queue_state",
  "table:rika_thread_turn_activity",
  "index:rika_thread_turn_activity_summary",
  "table:rika_thread_read_state",
  "table:rika_goals",
  "table:rika_thread_search",
  "table:rika_thread_search_data",
  "table:rika_thread_search_idx",
  "table:rika_thread_search_content",
  "table:rika_thread_search_docsize",
  "table:rika_thread_search_config",
  "table:rika_thread_search_files",
  "index:rika_thread_search_files_path",
  "table:rika_transcript_checkpoints",
  "table:rika_transcript_units",
  "index:rika_transcript_units_page",
  "index:rika_transcript_units_turn",
  "table:rika_thread_picker_summary",
  "index:rika_thread_picker_summary_listing",
  "trigger:rika_thread_picker_summary_thread_insert",
  "trigger:rika_thread_picker_summary_thread_update",
  "trigger:rika_thread_picker_summary_turn_insert",
  "trigger:rika_thread_picker_summary_turn_update",
  "trigger:rika_thread_picker_summary_turn_before_delete",
  "trigger:rika_thread_picker_summary_turn_delete",
  "trigger:rika_thread_picker_summary_activity_insert",
  "trigger:rika_thread_picker_summary_activity_update",
  "trigger:rika_thread_picker_summary_activity_delete",
  "table:rika_execution_route_contract",
  "table:rika_schema_identity",
]

/**
 * Objects a database created by an earlier Rika will not have. A data root outlives the version that
 * made it, so a release that adds a table brings it rather than asking for a fresh one.
 */
export const additions: ReadonlyArray<{
  readonly name: string
  readonly since: string
  readonly apply: (sql: SqlClient) => Effect.Effect<unknown, SqlError>
}> = [
  {
    name: "table:rika_execution_route_contract",
    since: "0.5.48",
    apply: (sql) =>
      Effect.gen(function* () {
        yield* sql`CREATE TABLE rika_execution_route_contract (
          id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
          version INTEGER NOT NULL CHECK (version = 3)
        )`
        yield* sql`INSERT INTO rika_execution_route_contract (id, version) VALUES (1, 3)`
        const turns = yield* sql`SELECT id, execution_route_json FROM rika_turns
          WHERE execution_route_json IS NOT NULL AND json_extract(execution_route_json, '$.version') IN (1, 2)`
        for (const raw of turns) {
          const row = raw as Record<string, unknown>
          const migrated = migrateExecutionRouteJson(String(row.execution_route_json), [])
          if (migrated !== undefined)
            yield* sql`UPDATE rika_turns SET execution_route_json = ${migrated} WHERE id = ${String(row.id)}`
        }
        const admissions = yield* sql`SELECT turn_id, start_input_json FROM rika_turn_admission_outbox
          WHERE json_extract(start_input_json, '$.executionRoute.version') IN (1, 2)`
        for (const raw of admissions) {
          const row = raw as Record<string, unknown>
          const migrated = migrateExecutionRouteJson(String(row.start_input_json), ["executionRoute"])
          if (migrated !== undefined)
            yield* sql`UPDATE rika_turn_admission_outbox SET start_input_json = ${migrated}
              WHERE turn_id = ${String(row.turn_id)}`
        }
        const steeringTable = yield* sql`SELECT name FROM sqlite_schema
          WHERE type = 'table' AND name = 'rika_turn_steering_outbox'`
        if (steeringTable.length > 0) {
          const steeringAdmissions = yield* sql`SELECT request_id, admission_json FROM rika_turn_steering_outbox
            WHERE json_extract(admission_json, '$.source.executionRoute.version') IN (1, 2)`
          for (const raw of steeringAdmissions) {
            const row = raw as Record<string, unknown>
            const migrated = migrateExecutionRouteJson(String(row.admission_json), ["source", "executionRoute"])
            if (migrated !== undefined)
              yield* sql`UPDATE rika_turn_steering_outbox SET admission_json = ${migrated}
                WHERE request_id = ${String(row.request_id)}`
          }
        }
      }),
  },
  {
    name: "table:rika_turn_steering_outbox",
    since: "0.5.10",
    apply: (sql) => sql`CREATE TABLE rika_turn_steering_outbox (
    request_id TEXT PRIMARY KEY NOT NULL,
    target_turn_id TEXT NOT NULL REFERENCES rika_turns(id) ON DELETE CASCADE,
    source_turn_id TEXT UNIQUE,
    thread_id TEXT NOT NULL REFERENCES rika_threads(id) ON DELETE CASCADE,
    admission_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'rejected')),
    prepared_at INTEGER NOT NULL
  )`,
  },
  {
    name: "table:rika_thread_deletion_outbox",
    since: "0.5.7",
    apply: (sql) => sql`CREATE TABLE rika_thread_deletion_outbox (
    thread_id TEXT PRIMARY KEY NOT NULL REFERENCES rika_threads(id) ON DELETE CASCADE,
    requested_at INTEGER NOT NULL
  )`,
  },
  {
    name: "trigger:rika_tombstoned_thread_turn_insert",
    since: "0.5.7",
    apply: (sql) => sql`CREATE TRIGGER rika_tombstoned_thread_turn_insert
    BEFORE INSERT ON rika_turns
    WHEN EXISTS (SELECT 1 FROM rika_thread_deletion_outbox WHERE thread_id = NEW.thread_id) BEGIN
      SELECT RAISE(ABORT, 'thread deletion is pending');
    END`,
  },
  {
    name: "table:rika_goals",
    since: "0.5.6",
    apply: (sql) => sql`CREATE TABLE rika_goals (
    thread_id TEXT PRIMARY KEY NOT NULL REFERENCES rika_threads(id) ON DELETE CASCADE,
    objective TEXT NOT NULL CHECK (length(objective) > 0 AND length(objective) <= 4096),
    status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'complete', 'errored')),
    budget_tokens INTEGER CHECK (budget_tokens IS NULL OR budget_tokens > 0),
    budget_wall_clock_millis INTEGER CHECK (budget_wall_clock_millis IS NULL OR budget_wall_clock_millis > 0),
    usage_tokens INTEGER NOT NULL DEFAULT 0 CHECK (usage_tokens >= 0),
    usage_elapsed_millis INTEGER NOT NULL DEFAULT 0 CHECK (usage_elapsed_millis >= 0),
    usage_turns INTEGER NOT NULL DEFAULT 0 CHECK (usage_turns >= 0),
    started_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    completed_at INTEGER,
    summary TEXT,
    CHECK ((status = 'complete') = (completed_at IS NOT NULL))
  )`,
  },
]
const versionAtLeast = (left: string, right: string): boolean => {
  const leftParts = left.split(".").map(Number)
  const rightParts = right.split(".").map(Number)
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0)
    if (difference !== 0) return difference > 0
  }
  return true
}

export const knownObjectShapes: ReadonlyArray<{
  readonly version: string
  readonly objects: ReadonlyArray<string>
}> = [...new Set(additions.map((addition) => addition.since))].map((version) => ({
  version,
  objects: schemaObjects.filter(
    (key) => !additions.some((addition) => versionAtLeast(addition.since, version) && addition.name === key),
  ),
}))
