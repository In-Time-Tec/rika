ALTER TABLE rika_hosted_executor_assignments
  ADD COLUMN capability_generation BIGINT,
  ADD COLUMN capability_snapshot JSONB,
  ADD CONSTRAINT rika_hosted_executor_assignments_capability_fence CHECK (
    (capability_generation IS NULL AND capability_snapshot IS NULL)
    OR (capability_generation = generation AND capability_snapshot IS NOT NULL)
  );

CREATE FUNCTION rika_hosted_clear_stale_assignment_capabilities()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.generation <> OLD.generation THEN
    NEW.capability_generation := NULL;
    NEW.capability_snapshot := NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER rika_hosted_assignment_capability_fence
BEFORE UPDATE OF generation ON rika_hosted_executor_assignments
FOR EACH ROW EXECUTE FUNCTION rika_hosted_clear_stale_assignment_capabilities();

CREATE TABLE rika_hosted_workspace_capability_admissions (
  thread_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  assignment_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  assignment_generation BIGINT NOT NULL CHECK (assignment_generation >= 1),
  environment_digest TEXT NOT NULL CHECK (environment_digest ~ '^sha256:[a-f0-9]{64}$'),
  required_capabilities JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (thread_id, turn_id),
  FOREIGN KEY (assignment_id) REFERENCES rika_hosted_executor_assignments (id) ON DELETE CASCADE
);

ALTER TABLE rika_hosted_executor_operations
  ADD COLUMN replay_policy TEXT NOT NULL DEFAULT 'never'
    CHECK (replay_policy IN ('pure', 'provider-idempotent', 'never')),
  ADD COLUMN started_at TIMESTAMPTZ,
  ADD COLUMN resolution_state TEXT
    CHECK (resolution_state IN ('pending', 'retrying', 'accepted', 'aborted')),
  ADD COLUMN resolution_idempotency_key TEXT,
  ADD COLUMN resolution JSONB,
  ADD COLUMN resolved_at TIMESTAMPTZ,
  ADD CONSTRAINT rika_hosted_executor_operation_resolution CHECK (
    (resolution_state IS NULL AND resolution_idempotency_key IS NULL AND resolution IS NULL AND resolved_at IS NULL)
    OR (
      state = 'unknown'
      AND resolution_state IS NOT NULL
      AND (
        (resolution_state = 'pending' AND resolution_idempotency_key IS NULL AND resolution IS NULL AND resolved_at IS NULL)
        OR (resolution_state <> 'pending' AND resolution_idempotency_key IS NOT NULL AND resolution IS NOT NULL AND resolved_at IS NOT NULL)
      )
    )
  );

UPDATE rika_hosted_executor_operations SET resolution_state = 'pending' WHERE state = 'unknown';

ALTER TABLE rika_hosted_executor_operation_frames
  DROP CONSTRAINT rika_hosted_executor_operatio_assignment_id_operation_key__fkey,
  DROP CONSTRAINT rika_hosted_executor_operation_frames_pkey;

DROP INDEX rika_hosted_executor_operation_terminal_receipt;

ALTER TABLE rika_hosted_executor_operations
  DROP CONSTRAINT rika_hosted_executor_operations_pkey,
  ADD PRIMARY KEY (assignment_id, operation_key, attempt);

ALTER TABLE rika_hosted_executor_operation_frames
  ADD PRIMARY KEY (assignment_id, operation_key, attempt, cursor),
  ADD FOREIGN KEY (assignment_id, operation_key, attempt)
    REFERENCES rika_hosted_executor_operations (assignment_id, operation_key, attempt) ON DELETE CASCADE;

CREATE UNIQUE INDEX rika_hosted_executor_operation_terminal_receipt
  ON rika_hosted_executor_operation_frames (assignment_id, operation_key, attempt)
  WHERE kind = 'Terminal';
