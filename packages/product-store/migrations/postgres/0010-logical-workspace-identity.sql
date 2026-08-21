ALTER TABLE rika_hosted_threads
  ADD CONSTRAINT rika_hosted_threads_workspace_authority
  UNIQUE (id, owner_id, workspace_id);

ALTER TABLE rika_hosted_executor_assignments
  ADD COLUMN workspace_id TEXT NOT NULL,
  ADD CONSTRAINT rika_hosted_executor_assignments_workspace_authority
  FOREIGN KEY (thread_id, owner_id, workspace_id)
    REFERENCES rika_hosted_threads (id, owner_id, workspace_id) ON DELETE CASCADE;
