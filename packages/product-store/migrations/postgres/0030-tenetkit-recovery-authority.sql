ALTER TABLE rika_hosted_executor_operations
  DROP CONSTRAINT rika_hosted_executor_operation_resolution,
  DROP COLUMN resolution_state,
  DROP COLUMN resolution_idempotency_key,
  DROP COLUMN resolution,
  DROP COLUMN resolved_at;
