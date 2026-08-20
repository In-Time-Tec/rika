CREATE TABLE rika_hosted_local_executor_admissions (
  id TEXT PRIMARY KEY,
  assignment_id TEXT NOT NULL REFERENCES rika_hosted_executor_assignments(id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  process_incarnation TEXT,
  generation BIGINT NOT NULL CHECK (generation >= 1),
  workspace_fingerprint TEXT NOT NULL CHECK (length(workspace_fingerprint) BETWEEN 1 AND 512),
  ticket_digest TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  CHECK (expires_at > created_at)
);
CREATE INDEX rika_hosted_local_executor_admissions_binding ON rika_hosted_local_executor_admissions (assignment_id, device_id, client_id, generation) WHERE consumed_at IS NOT NULL;

CREATE TYPE rika_hosted_local_executor_operation_state AS ENUM ('accepted', 'dispatched', 'completed', 'unknown');
CREATE TABLE rika_hosted_executor_operations (
  assignment_id TEXT NOT NULL REFERENCES rika_hosted_executor_assignments(id) ON DELETE CASCADE,
  operation_key TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  code TEXT NOT NULL,
  attempt BIGINT NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  state rika_hosted_local_executor_operation_state NOT NULL DEFAULT 'accepted',
  dispatched_generation BIGINT,
  dispatched_lease_epoch BIGINT,
  response JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (assignment_id, operation_key),
  CHECK ((state IN ('completed', 'unknown') AND response IS NOT NULL) OR (state NOT IN ('completed', 'unknown') AND response IS NULL)),
  CHECK ((state = 'dispatched' AND dispatched_generation IS NOT NULL AND dispatched_lease_epoch IS NOT NULL) OR state <> 'dispatched')
);
