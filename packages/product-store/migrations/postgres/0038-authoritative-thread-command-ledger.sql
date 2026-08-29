ALTER TABLE rika_hosted_thread_events
  DROP CONSTRAINT rika_hosted_thread_events_thread_id_owner_id_command_seque_fkey;

DROP TABLE rika_hosted_thread_protocol_commands;

CREATE TABLE rika_hosted_thread_protocol_commands (
  owner_id TEXT NOT NULL REFERENCES rika_hosted_owners (id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  expected_version BIGINT NOT NULL CHECK (expected_version >= 0),
  thread_version BIGINT NOT NULL CHECK (thread_version > 0),
  commit_cursor BIGINT NOT NULL CHECK (commit_cursor >= 1),
  actor JSONB NOT NULL CHECK (jsonb_typeof(actor) = 'object'),
  command JSONB NOT NULL CHECK (jsonb_typeof(command) = 'object'),
  state TEXT NOT NULL CHECK (state IN ('admitted', 'completed')),
  work_state TEXT CHECK (work_state IN ('turn-activation-pending', 'turn-activation-requested')),
  prepared_turn_json TEXT,
  result JSONB,
  event_cursor BIGINT CHECK (event_cursor >= 0),
  admitted_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  claim_token TEXT,
  claim_expires_at TIMESTAMPTZ,
  turn_id TEXT,
  admission_status TEXT CHECK (admission_status IN ('accepted', 'queued')),
  cancelled_by_command_id TEXT,
  PRIMARY KEY (thread_id, command_id),
  UNIQUE (owner_id, commit_cursor),
  UNIQUE (thread_id, idempotency_key),
  UNIQUE (thread_id, thread_version),
  UNIQUE (thread_id, owner_id, thread_version),
  UNIQUE (turn_id),
  FOREIGN KEY (thread_id, owner_id)
    REFERENCES rika_hosted_thread_protocol_state (thread_id, owner_id) ON DELETE CASCADE,
  CHECK (rika_hosted_actor_matches_owner(actor, owner_id)),
  CHECK ((claim_token IS NULL) = (claim_expires_at IS NULL)),
  CHECK (state = 'admitted' OR work_state IS NOT NULL OR claim_token IS NULL),
  CHECK (
    (state = 'admitted'
      AND result IS NULL
      AND event_cursor IS NULL
      AND completed_at IS NULL
      AND work_state IS NULL
      AND admission_status IS NULL
      AND cancelled_by_command_id IS NULL)
    OR (state = 'completed' AND result IS NOT NULL AND event_cursor IS NOT NULL AND completed_at IS NOT NULL)
  ),
  CHECK (
    work_state IS NULL
    OR (state = 'completed'
      AND turn_id IS NOT NULL
      AND admission_status IS NOT NULL
      AND prepared_turn_json IS NOT NULL)
  ),
  CHECK (cancelled_by_command_id IS NULL OR (state = 'completed' AND cancelled_by_command_id <> command_id))
);

CREATE INDEX rika_hosted_thread_protocol_commands_cursor
  ON rika_hosted_thread_protocol_commands (owner_id, thread_id, commit_cursor);
CREATE INDEX rika_hosted_thread_protocol_commands_turn
  ON rika_hosted_thread_protocol_commands (owner_id, thread_id, turn_id)
  WHERE turn_id IS NOT NULL;
CREATE INDEX rika_hosted_thread_protocol_commands_claims
  ON rika_hosted_thread_protocol_commands (claim_expires_at)
  WHERE claim_token IS NOT NULL;
CREATE INDEX rika_hosted_thread_protocol_commands_work
  ON rika_hosted_thread_protocol_commands (work_state, completed_at, thread_id)
  WHERE work_state IS NOT NULL;

UPDATE rika_hosted_thread_events SET command_sequence = NULL WHERE command_sequence IS NOT NULL;

DROP TABLE rika_hosted_prompt_cancellations;
DROP TABLE rika_hosted_thread_commands;
DROP TABLE rika_hosted_turn_claims;

ALTER TABLE rika_hosted_threads DROP COLUMN next_command_sequence;

DROP INDEX rika_turn_admission_outbox_activation;
ALTER TABLE rika_turn_admission_outbox
  DROP COLUMN prepared_turn_json,
  DROP COLUMN admission_link_json,
  DROP COLUMN admitted_at,
  DROP COLUMN activation_requested_at;

ALTER TABLE rika_hosted_thread_events
  ADD CONSTRAINT rika_hosted_thread_events_thread_id_owner_id_command_seque_fkey
  FOREIGN KEY (thread_id, owner_id, command_sequence)
  REFERENCES rika_hosted_thread_protocol_commands (thread_id, owner_id, thread_version)
  ON DELETE RESTRICT;

CREATE TRIGGER rika_hosted_protocol_command_notification
AFTER INSERT OR UPDATE ON rika_hosted_thread_protocol_commands
FOR EACH ROW
EXECUTE FUNCTION rika_hosted_notify_thread_change();
