ALTER TABLE rika_hosted_thread_protocol_commands
  ADD COLUMN turn_id TEXT;

UPDATE rika_hosted_thread_protocol_commands
SET turn_id = 'legacy:' || owner_id || ':' || thread_id || ':' || command_id;

ALTER TABLE rika_hosted_thread_protocol_commands
  ALTER COLUMN turn_id SET NOT NULL,
  ADD CONSTRAINT rika_hosted_thread_protocol_commands_turn_id_key UNIQUE (turn_id);
