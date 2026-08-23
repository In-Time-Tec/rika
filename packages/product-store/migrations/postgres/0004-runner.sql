CREATE TABLE rika_hosted_runner_admissions (
  id TEXT PRIMARY KEY,
  assignment_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  process_incarnation TEXT,
  generation BIGINT NOT NULL CHECK (generation >= 1),
  workspace_fingerprint TEXT NOT NULL CHECK (length(workspace_fingerprint) BETWEEN 1 AND 512),
  ticket_digest TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  FOREIGN KEY (owner_id) REFERENCES rika_hosted_owners (id) ON DELETE CASCADE,
  FOREIGN KEY (assignment_id, owner_id) REFERENCES rika_hosted_executor_assignments (id, owner_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES "user" (id) ON DELETE CASCADE,
  FOREIGN KEY (device_id, user_id) REFERENCES rika_hosted_devices (id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (client_id, user_id) REFERENCES rika_hosted_clients (id, user_id) ON DELETE CASCADE,
  CHECK (expires_at > created_at)
);

CREATE INDEX rika_hosted_runner_admissions_binding
  ON rika_hosted_runner_admissions (assignment_id, device_id, client_id, generation)
  WHERE consumed_at IS NOT NULL;

CREATE TYPE rika_hosted_runner_operation_state AS ENUM ('accepted', 'dispatched', 'completed', 'unknown');

CREATE TABLE rika_hosted_executor_operations (
  assignment_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  operation_key TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  code TEXT NOT NULL,
  attempt BIGINT NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  state rika_hosted_runner_operation_state NOT NULL DEFAULT 'accepted',
  dispatched_generation BIGINT,
  dispatched_lease_epoch BIGINT,
  dispatched_executor_instance_id TEXT,
  dispatched_process_incarnation TEXT,
  dispatch_deadline_at TIMESTAMPTZ,
  response JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (assignment_id, operation_key),
  FOREIGN KEY (owner_id) REFERENCES rika_hosted_owners (id) ON DELETE CASCADE,
  FOREIGN KEY (assignment_id, owner_id) REFERENCES rika_hosted_executor_assignments (id, owner_id) ON DELETE CASCADE,
  CHECK ((state IN ('completed', 'unknown') AND response IS NOT NULL) OR (state NOT IN ('completed', 'unknown') AND response IS NULL)),
  CHECK ((state = 'dispatched' AND dispatched_generation IS NOT NULL AND dispatched_lease_epoch IS NOT NULL) OR state <> 'dispatched'),
  CHECK (
    state NOT IN ('dispatched', 'unknown')
    OR (
      dispatched_generation IS NOT NULL
      AND dispatched_lease_epoch IS NOT NULL
      AND dispatched_executor_instance_id IS NOT NULL
      AND dispatched_process_incarnation IS NOT NULL
    )
  ),
  CHECK (state <> 'dispatched' OR dispatch_deadline_at IS NOT NULL),
  CHECK (state <> 'unknown' OR dispatch_deadline_at IS NULL)
);

CREATE INDEX rika_hosted_executor_operations_recovery
  ON rika_hosted_executor_operations (state, dispatch_deadline_at)
  WHERE state = 'dispatched';
