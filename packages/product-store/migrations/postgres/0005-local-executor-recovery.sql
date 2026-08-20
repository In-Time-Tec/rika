-- Persist the original executor fence and a bounded delivery window for crash recovery.
-- A terminal unknown event must name the executor that owned the dispatch even after
-- assignment replacement. A deadline lets any API replica reap a claim after a crash.
ALTER TABLE rika_hosted_executor_operations
  ADD COLUMN dispatched_executor_instance_id TEXT,
  ADD COLUMN dispatched_process_incarnation TEXT,
  ADD COLUMN dispatch_deadline_at TIMESTAMPTZ;

UPDATE rika_hosted_executor_operations operation
SET dispatched_executor_instance_id = assignment.executor_instance_id,
    dispatched_process_incarnation = assignment.process_incarnation
FROM rika_hosted_executor_assignments assignment
WHERE operation.assignment_id = assignment.id
  AND operation.state = 'dispatched'
  AND operation.dispatched_generation = assignment.generation
  AND operation.dispatched_lease_epoch = assignment.lease_epoch
  AND operation.dispatched_executor_instance_id IS NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM rika_hosted_executor_operations operation
    WHERE operation.state = 'dispatched'
      AND (
        operation.dispatched_executor_instance_id IS NULL
        OR operation.dispatched_process_incarnation IS NULL
      )
  ) THEN
    RAISE EXCEPTION 'local executor recovery migration found a dispatch without its original fence';
  END IF;
END;
$$;

UPDATE rika_hosted_executor_operations
SET dispatch_deadline_at = clock_timestamp() + interval '5 minutes'
WHERE state = 'dispatched' AND dispatch_deadline_at IS NULL;

UPDATE rika_hosted_executor_operations
SET dispatch_deadline_at = NULL
WHERE state = 'unknown' AND dispatch_deadline_at IS NOT NULL;

-- Recovered terminal events are authorized by the immutable dispatch fence
-- recorded on the operation row, not by the currently active assignment lease.
CREATE OR REPLACE FUNCTION rika_hosted_validate_executor_fence()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM rika_hosted_executor_assignments assignment
    WHERE assignment.organization_id = NEW.organization_id
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
      WHERE operation.assignment_id = NEW.assignment_id
        AND operation.operation_key = NEW.idempotency_key
        AND operation.state = 'unknown'
        AND operation.dispatched_generation = NEW.assignment_generation
        AND operation.dispatched_lease_epoch = NEW.lease_epoch
        AND operation.dispatched_executor_instance_id = NEW.executor_instance_id
    ) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'stale executor fence' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

ALTER TABLE rika_hosted_executor_operations
  ADD CONSTRAINT rika_hosted_executor_operations_recovery_fence
    CHECK (
      state NOT IN ('dispatched', 'unknown')
      OR (
        dispatched_generation IS NOT NULL
        AND dispatched_lease_epoch IS NOT NULL
        AND dispatched_executor_instance_id IS NOT NULL
        AND dispatched_process_incarnation IS NOT NULL
      )
    ) NOT VALID,
  ADD CONSTRAINT rika_hosted_executor_operations_dispatch_deadline
    CHECK (state <> 'dispatched' OR dispatch_deadline_at IS NOT NULL),
  ADD CONSTRAINT rika_hosted_executor_operations_unknown_deadline
    CHECK (state <> 'unknown' OR dispatch_deadline_at IS NULL);

CREATE INDEX rika_hosted_executor_operations_recovery
  ON rika_hosted_executor_operations (state, dispatch_deadline_at)
  WHERE state = 'dispatched';
