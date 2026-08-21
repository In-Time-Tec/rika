CREATE TABLE rika_workspaces (
  owner_id TEXT NOT NULL REFERENCES rika_hosted_owners(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  created_at DOUBLE PRECISION NOT NULL,
  PRIMARY KEY (owner_id, path)
);

CREATE TABLE rika_threads (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES rika_hosted_owners(id) ON DELETE CASCADE,
  workspace TEXT NOT NULL,
  title TEXT NOT NULL,
  labels_json TEXT NOT NULL DEFAULT '[]',
  pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  lineage_json TEXT NOT NULL DEFAULT '{"_tag":"Original"}',
  created_at DOUBLE PRECISION NOT NULL,
  updated_at DOUBLE PRECISION NOT NULL,
  FOREIGN KEY (owner_id, workspace) REFERENCES rika_workspaces(owner_id, path)
);

CREATE INDEX rika_threads_listing
  ON rika_threads (owner_id, pinned DESC, updated_at DESC, id);

CREATE TABLE rika_thread_deletion_outbox (
  thread_id TEXT PRIMARY KEY REFERENCES rika_threads(id) ON DELETE CASCADE,
  requested_at DOUBLE PRECISION NOT NULL
);

CREATE TABLE rika_turns (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES rika_threads(id) ON DELETE CASCADE,
  prompt TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'accepted', 'queued', 'running', 'waiting', 'cancelling', 'completed', 'failed', 'cancelled'
  )),
  created_at DOUBLE PRECISION NOT NULL,
  updated_at DOUBLE PRECISION NOT NULL,
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
  turn_kind TEXT NOT NULL DEFAULT 'AgentExecution',
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
        (status IN ('completed', 'failed', 'cancelled') AND shell_result_text IS NOT NULL
          AND shell_result_truncated IN (0, 1))
      )
    )
  )
);

CREATE INDEX rika_turns_thread ON rika_turns (thread_id, created_at, id);
CREATE INDEX rika_turns_queue ON rika_turns (thread_id, status, created_at, id);
CREATE UNIQUE INDEX rika_turns_queue_claim ON rika_turns (thread_id) WHERE queue_claim_token IS NOT NULL;
CREATE UNIQUE INDEX rika_turns_one_active
  ON rika_turns (thread_id)
  WHERE turn_kind = 'AgentExecution' AND status IN ('accepted', 'running', 'waiting', 'cancelling');
CREATE INDEX rika_turns_thread_updated ON rika_turns (thread_id, updated_at DESC);
CREATE INDEX rika_turns_thread_nonqueued ON rika_turns (thread_id, created_at DESC, id DESC)
  WHERE status <> 'queued';

CREATE FUNCTION rika_product_reject_tombstoned_turn()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.thread_id, 0));
  IF EXISTS (SELECT 1 FROM rika_thread_deletion_outbox WHERE thread_id = NEW.thread_id) THEN
    RAISE EXCEPTION 'thread deletion is pending' USING ERRCODE = '23514';
  END IF;
  IF NEW.turn_kind = 'AgentExecution' AND NEW.status = 'accepted' AND EXISTS (
    SELECT 1 FROM rika_turns
    WHERE thread_id = NEW.thread_id AND turn_kind = 'AgentExecution'
      AND status IN ('queued', 'accepted', 'running', 'waiting', 'cancelling')
  ) THEN
    NEW.status := 'queued';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER rika_tombstoned_thread_turn_insert
  BEFORE INSERT ON rika_turns
  FOR EACH ROW EXECUTE FUNCTION rika_product_reject_tombstoned_turn();

CREATE TABLE rika_turn_admission_outbox (
  turn_id TEXT PRIMARY KEY REFERENCES rika_turns(id) ON DELETE CASCADE,
  start_input_json TEXT NOT NULL,
  prepared_at DOUBLE PRECISION NOT NULL
);

CREATE TABLE rika_turn_steering_outbox (
  request_id TEXT PRIMARY KEY,
  target_turn_id TEXT NOT NULL REFERENCES rika_turns(id) ON DELETE CASCADE,
  source_turn_id TEXT UNIQUE REFERENCES rika_turns(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL REFERENCES rika_threads(id) ON DELETE CASCADE,
  admission_json TEXT NOT NULL,
  source_withdrawn INTEGER NOT NULL CHECK (source_withdrawn IN (0, 1)),
  status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'rejected')),
  prepared_at DOUBLE PRECISION NOT NULL
);

CREATE TABLE rika_thread_queue_state (
  thread_id TEXT PRIMARY KEY REFERENCES rika_threads(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  queued_count INTEGER NOT NULL DEFAULT 0 CHECK (queued_count >= 0)
);

CREATE TABLE rika_thread_turn_activity (
  turn_id TEXT PRIMARY KEY REFERENCES rika_turns(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL REFERENCES rika_threads(id) ON DELETE CASCADE,
  projected_cursor TEXT,
  complete INTEGER NOT NULL DEFAULT 0 CHECK (complete IN (0, 1)),
  added INTEGER NOT NULL DEFAULT 0 CHECK (added >= 0),
  modified INTEGER NOT NULL DEFAULT 0 CHECK (modified >= 0),
  removed INTEGER NOT NULL DEFAULT 0 CHECK (removed >= 0),
  last_event_at DOUBLE PRECISION,
  updated_at DOUBLE PRECISION NOT NULL
);

CREATE INDEX rika_thread_turn_activity_summary
  ON rika_thread_turn_activity (thread_id, last_event_at DESC);

CREATE TABLE rika_thread_read_state (
  thread_id TEXT PRIMARY KEY REFERENCES rika_threads(id) ON DELETE CASCADE,
  last_read_at DOUBLE PRECISION NOT NULL
);

CREATE TABLE rika_goals (
  thread_id TEXT PRIMARY KEY REFERENCES rika_threads(id) ON DELETE CASCADE,
  objective TEXT NOT NULL CHECK (length(objective) > 0 AND length(objective) <= 4096),
  status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'complete', 'errored')),
  budget_tokens INTEGER CHECK (budget_tokens IS NULL OR budget_tokens > 0),
  budget_wall_clock_millis DOUBLE PRECISION CHECK (
    budget_wall_clock_millis IS NULL OR budget_wall_clock_millis > 0
  ),
  usage_tokens INTEGER NOT NULL DEFAULT 0 CHECK (usage_tokens >= 0),
  usage_elapsed_millis DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (usage_elapsed_millis >= 0),
  usage_turns INTEGER NOT NULL DEFAULT 0 CHECK (usage_turns >= 0),
  started_at DOUBLE PRECISION NOT NULL,
  updated_at DOUBLE PRECISION NOT NULL,
  completed_at DOUBLE PRECISION,
  summary TEXT,
  CHECK ((status = 'complete') = (completed_at IS NOT NULL))
);

CREATE TABLE rika_transcript_checkpoints (
  turn_id TEXT PRIMARY KEY REFERENCES rika_turns(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL REFERENCES rika_threads(id) ON DELETE CASCADE,
  checkpoint_generation INTEGER NOT NULL DEFAULT 0 CHECK (checkpoint_generation >= 0),
  revision INTEGER NOT NULL DEFAULT -1 CHECK (revision >= -1),
  projection_version INTEGER NOT NULL DEFAULT 1 CHECK (projection_version >= 1),
  state_json TEXT NOT NULL,
  projector_version INTEGER CHECK (projector_version IS NULL OR projector_version >= 1),
  projector_cursor TEXT,
  projector_state TEXT,
  updated_at DOUBLE PRECISION NOT NULL,
  CHECK (
    (projector_version IS NULL AND projector_cursor IS NULL AND projector_state IS NULL)
    OR
    (projector_version IS NOT NULL AND projector_cursor IS NOT NULL AND projector_state IS NOT NULL)
  )
);

CREATE TABLE rika_transcript_units (
  turn_id TEXT NOT NULL REFERENCES rika_turns(id) ON DELETE CASCADE,
  unit_key TEXT NOT NULL,
  thread_id TEXT NOT NULL REFERENCES rika_threads(id) ON DELETE CASCADE,
  unit_order_key TEXT COLLATE "C" NOT NULL,
  parent_id TEXT,
  revision INTEGER NOT NULL,
  unit_json TEXT NOT NULL,
  created_at DOUBLE PRECISION NOT NULL,
  updated_at DOUBLE PRECISION NOT NULL,
  PRIMARY KEY (turn_id, unit_key),
  UNIQUE (turn_id, unit_order_key)
);

CREATE INDEX rika_transcript_units_page
  ON rika_transcript_units (thread_id, created_at DESC, turn_id DESC, unit_order_key DESC);
CREATE INDEX rika_transcript_units_turn ON rika_transcript_units (turn_id, unit_order_key);

CREATE VIEW rika_thread_picker_summary AS
SELECT
  thread.id AS thread_id,
  thread.workspace,
  thread.title,
  thread.pinned,
  thread.archived,
  CASE
    WHEN count(turn.id) FILTER (WHERE turn.status IN ('accepted', 'running', 'waiting', 'cancelling')) > 0 THEN 2
    WHEN count(turn.id) FILTER (WHERE turn.status = 'queued') > 0 THEN 1
    ELSE 0
  END::INTEGER AS status_rank,
  (
    SELECT latest.status FROM rika_turns latest
    WHERE latest.thread_id = thread.id
    ORDER BY latest.created_at DESC, latest.id DESC LIMIT 1
  ) AS last_status,
  greatest(
    thread.created_at,
    coalesce(max(turn.updated_at), 0),
    coalesce(max(activity.last_event_at), 0)
  )::DOUBLE PRECISION AS last_activity_at,
  count(turn.id)::INTEGER AS turn_count,
  count(turn.id) FILTER (
    WHERE activity.turn_id IS NOT NULL
      AND (turn.status NOT IN ('completed', 'failed', 'cancelled') OR activity.complete = 1)
  )::INTEGER AS current_activity_count,
  coalesce(sum(activity.added), 0)::INTEGER AS added,
  coalesce(sum(activity.modified), 0)::INTEGER AS modified,
  coalesce(sum(activity.removed), 0)::INTEGER AS removed
FROM rika_threads thread
LEFT JOIN rika_turns turn ON turn.thread_id = thread.id
LEFT JOIN rika_thread_turn_activity activity ON activity.turn_id = turn.id
GROUP BY thread.id;
