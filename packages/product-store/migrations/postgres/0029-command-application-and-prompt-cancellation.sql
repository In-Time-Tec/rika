ALTER TABLE rika_hosted_thread_protocol_commands
  ADD COLUMN claim_token TEXT,
  ADD COLUMN claim_expires_at TIMESTAMPTZ,
  ADD CHECK ((claim_token IS NULL) = (claim_expires_at IS NULL)),
  ADD CHECK (state = 'admitted' OR claim_token IS NULL);

CREATE INDEX rika_hosted_thread_protocol_commands_claims
  ON rika_hosted_thread_protocol_commands (claim_expires_at)
  WHERE state = 'admitted';

CREATE TABLE rika_hosted_prompt_cancellations (
  owner_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  target_command_id TEXT NOT NULL,
  cancel_command_id TEXT NOT NULL,
  actor JSONB NOT NULL,
  cancelled_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (thread_id, target_command_id),
  UNIQUE (thread_id, cancel_command_id),
  CHECK (jsonb_typeof(actor) = 'object'),
  CHECK (rika_hosted_actor_matches_owner(actor, owner_id)),
  FOREIGN KEY (thread_id, owner_id)
    REFERENCES rika_hosted_threads (id, owner_id) ON DELETE CASCADE
);
