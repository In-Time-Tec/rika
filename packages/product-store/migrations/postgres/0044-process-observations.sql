CREATE TABLE rika_hosted_executor_process_observations (
  assignment_id text NOT NULL,
  operation_key text NOT NULL,
  attempt bigint NOT NULL,
  process_id text NOT NULL,
  observation jsonb NOT NULL,
  created_at timestamptz DEFAULT transaction_timestamp() NOT NULL,
  CONSTRAINT rika_hosted_executor_process_observations_pkey
    PRIMARY KEY (assignment_id, operation_key, attempt, process_id),
  CONSTRAINT rika_hosted_executor_process_observations_operation_fkey
    FOREIGN KEY (assignment_id, operation_key, attempt)
    REFERENCES rika_hosted_executor_operations (assignment_id, operation_key, attempt)
    ON DELETE CASCADE,
  CONSTRAINT rika_hosted_executor_process_observations_attempt_check CHECK (attempt >= 0),
  CONSTRAINT rika_hosted_executor_process_observations_process_id_check CHECK (length(process_id) > 0),
  CONSTRAINT rika_hosted_executor_process_observations_json_check CHECK (
    jsonb_typeof(observation) = 'object'
    AND observation ->> 'processId' = process_id
  )
);
