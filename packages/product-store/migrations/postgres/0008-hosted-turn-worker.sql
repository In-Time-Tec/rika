CREATE TABLE rika_hosted_turn_claims (
  turn_id TEXT PRIMARY KEY REFERENCES rika_turns(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES rika_hosted_owners(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL UNIQUE REFERENCES rika_threads(id) ON DELETE CASCADE,
  worker_id TEXT NOT NULL CHECK (length(worker_id) > 0),
  claim_token TEXT NOT NULL UNIQUE CHECK (length(claim_token) > 0),
  claimed_at DOUBLE PRECISION NOT NULL,
  heartbeat_at DOUBLE PRECISION NOT NULL,
  expires_at DOUBLE PRECISION NOT NULL,
  CHECK (expires_at > heartbeat_at)
);

CREATE INDEX rika_hosted_turn_claims_expiry
  ON rika_hosted_turn_claims (expires_at, thread_id);
