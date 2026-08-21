ALTER TABLE rika_hosted_executor_operations
  ADD COLUMN workspace_id TEXT NOT NULL CHECK (length(workspace_id) > 0),
  ADD COLUMN session_id TEXT NOT NULL CHECK (length(session_id) > 0),
  ADD COLUMN thread_id TEXT NOT NULL CHECK (length(thread_id) > 0),
  ADD COLUMN turn_id TEXT NOT NULL CHECK (length(turn_id) > 0),
  ADD COLUMN run_id TEXT NOT NULL CHECK (length(run_id) > 0),
  ADD COLUMN root_run_id TEXT NOT NULL CHECK (length(root_run_id) > 0),
  ADD COLUMN tool_call_id TEXT NOT NULL CHECK (length(tool_call_id) > 0),
  ADD COLUMN admitted_at TEXT,
  ADD COLUMN deadline TEXT,
  ADD CONSTRAINT rika_hosted_executor_operations_thread
    FOREIGN KEY (thread_id) REFERENCES rika_hosted_threads (id) ON DELETE CASCADE;
