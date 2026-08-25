ALTER TABLE rika_hosted_executor_operations
  DROP CONSTRAINT rika_hosted_executor_operation_resolution,
  ADD CONSTRAINT rika_hosted_executor_operation_resolution CHECK (
    (resolution_state IS NULL AND resolution_idempotency_key IS NULL AND resolution IS NULL AND resolved_at IS NULL)
    OR (
      state IN ('dispatched', 'completed', 'unknown')
      AND resolution_state IS NOT NULL
      AND (
        (resolution_state = 'pending' AND resolution_idempotency_key IS NULL AND resolution IS NULL AND resolved_at IS NULL)
        OR (resolution_state <> 'pending' AND resolution_idempotency_key IS NOT NULL AND resolution IS NOT NULL AND resolved_at IS NOT NULL)
      )
    )
  );
