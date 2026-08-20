ALTER TABLE rika_hosted_executor_assignments
  ADD CONSTRAINT rika_hosted_executor_assignments_id_thread_id
  CHECK (id = thread_id);

ALTER TABLE rika_hosted_thread_events
  ADD CONSTRAINT rika_hosted_thread_events_assignment_thread_id
  CHECK (assignment_id = thread_id);

ALTER TABLE rika_hosted_checkpoints
  ADD CONSTRAINT rika_hosted_checkpoints_assignment_thread_id
  CHECK (assignment_id = thread_id);
