ALTER TABLE rika_hosted_thread_commands
  ADD COLUMN turn_id TEXT UNIQUE REFERENCES rika_turns(id) ON DELETE RESTRICT;

CREATE INDEX rika_hosted_thread_commands_turn
  ON rika_hosted_thread_commands (owner_id, thread_id, turn_id)
  WHERE turn_id IS NOT NULL;
