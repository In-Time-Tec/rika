CREATE OR REPLACE FUNCTION rika_hosted_validate_executor_fence()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM rika_hosted_executor_assignments assignment
    WHERE assignment.owner_id = NEW.owner_id
      AND assignment.thread_id = NEW.thread_id
      AND assignment.id = NEW.assignment_id
      AND assignment.executor_instance_id = NEW.executor_instance_id
      AND assignment.generation = NEW.assignment_generation
      AND assignment.lease_epoch = NEW.lease_epoch
      AND assignment.lifecycle = 'active'
      AND assignment.lease_expires_at > clock_timestamp()
  ) THEN
    IF TG_TABLE_NAME = 'rika_hosted_thread_events' AND EXISTS (
      SELECT 1
      FROM rika_hosted_executor_operations operation
      WHERE operation.owner_id = NEW.owner_id
        AND operation.assignment_id = NEW.assignment_id
        AND operation.operation_key = NEW.idempotency_key
        AND operation.state IN ('completed', 'unknown')
        AND operation.dispatched_generation = NEW.assignment_generation
        AND operation.dispatched_lease_epoch = NEW.lease_epoch
        AND operation.dispatched_executor_instance_id = NEW.executor_instance_id
        AND operation.response = NEW.event -> 'response'
        AND (
          operation.state = 'unknown'
          OR EXISTS (
            SELECT 1
            FROM rika_hosted_executor_operation_frames frame
            WHERE frame.assignment_id = operation.assignment_id
              AND frame.operation_key = operation.operation_key
              AND frame.attempt = operation.attempt
              AND frame.kind = 'Terminal'
              AND frame.frame -> 'response' = operation.response
              AND frame.frame ->> 'outcome' = operation.terminal_outcome
          )
        )
    ) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'stale executor fence' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
