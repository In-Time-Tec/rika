ALTER TABLE rika_hosted_executor_operations
  ADD CONSTRAINT rika_hosted_executor_operations_attempt
    UNIQUE (assignment_id, operation_key, attempt);

CREATE TABLE rika_hosted_executor_operation_frames (
  assignment_id TEXT NOT NULL,
  operation_key TEXT NOT NULL,
  attempt BIGINT NOT NULL CHECK (attempt >= 0),
  cursor BIGINT NOT NULL CHECK (cursor >= 1),
  kind TEXT NOT NULL CHECK (kind IN ('Accepted', 'Started', 'Output', 'Terminal')),
  frame JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (assignment_id, operation_key, cursor),
  FOREIGN KEY (assignment_id, operation_key, attempt)
    REFERENCES rika_hosted_executor_operations (assignment_id, operation_key, attempt) ON DELETE CASCADE
);

CREATE UNIQUE INDEX rika_hosted_executor_operation_terminal_receipt
  ON rika_hosted_executor_operation_frames (assignment_id, operation_key)
  WHERE kind = 'Terminal';
