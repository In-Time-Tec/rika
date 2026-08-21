CREATE TABLE rika_hosted_thread_protocol_state (
  owner_id TEXT NOT NULL,
  thread_id TEXT PRIMARY KEY,
  version BIGINT NOT NULL DEFAULT 0 CHECK (version >= 0),
  event_cursor BIGINT NOT NULL DEFAULT 0 CHECK (event_cursor >= 0),
  UNIQUE (thread_id, owner_id),
  FOREIGN KEY (thread_id, owner_id)
    REFERENCES rika_hosted_threads (id, owner_id) ON DELETE CASCADE
);

CREATE TABLE rika_hosted_thread_protocol_commands (
  owner_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  expected_version BIGINT NOT NULL CHECK (expected_version >= 0),
  thread_version BIGINT NOT NULL CHECK (thread_version > 0),
  actor JSONB NOT NULL,
  command JSONB NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('admitted', 'completed')),
  result JSONB,
  event_cursor BIGINT CHECK (event_cursor >= 0),
  admitted_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  PRIMARY KEY (thread_id, command_id),
  UNIQUE (thread_id, idempotency_key),
  UNIQUE (thread_id, thread_version),
  FOREIGN KEY (thread_id, owner_id)
    REFERENCES rika_hosted_thread_protocol_state (thread_id, owner_id) ON DELETE CASCADE,
  CHECK ((state = 'admitted' AND result IS NULL AND completed_at IS NULL)
    OR (state = 'completed' AND result IS NOT NULL AND event_cursor IS NOT NULL AND completed_at IS NOT NULL))
);

CREATE TABLE rika_hosted_thread_protocol_events (
  owner_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  sequence BIGINT NOT NULL CHECK (sequence > 0),
  cursor BIGINT NOT NULL CHECK (cursor > 0),
  thread_version BIGINT NOT NULL CHECK (thread_version >= 0),
  event JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (thread_id, sequence),
  UNIQUE (thread_id, cursor),
  FOREIGN KEY (thread_id, owner_id)
    REFERENCES rika_hosted_thread_protocol_state (thread_id, owner_id) ON DELETE CASCADE
);

CREATE TABLE rika_hosted_thread_protocol_snapshots (
  owner_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  thread_version BIGINT NOT NULL CHECK (thread_version >= 0),
  cursor BIGINT NOT NULL CHECK (cursor >= 0),
  snapshot JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (thread_id, thread_version),
  FOREIGN KEY (thread_id, owner_id)
    REFERENCES rika_hosted_thread_protocol_state (thread_id, owner_id) ON DELETE CASCADE
);

CREATE TABLE rika_hosted_thread_protocol_cursors (
  owner_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  cursor BIGINT NOT NULL CHECK (cursor >= 0),
  acknowledged_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (thread_id, client_id),
  FOREIGN KEY (thread_id, owner_id)
    REFERENCES rika_hosted_thread_protocol_state (thread_id, owner_id) ON DELETE CASCADE,
  FOREIGN KEY (client_id) REFERENCES rika_hosted_clients (id) ON DELETE CASCADE
);

CREATE TABLE rika_hosted_thread_socket_tickets (
  id TEXT PRIMARY KEY,
  ticket_digest TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  audience TEXT NOT NULL CHECK (length(audience) > 0),
  expires_at TIMESTAMPTZ NOT NULL,
  issued_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  FOREIGN KEY (client_id, user_id) REFERENCES rika_hosted_clients (id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (device_id, user_id) REFERENCES rika_hosted_devices (id, user_id) ON DELETE CASCADE,
  CHECK (expires_at > issued_at),
  CHECK (consumed_at IS NULL OR consumed_at >= issued_at),
  CHECK (revoked_at IS NULL OR revoked_at >= issued_at)
);

CREATE INDEX rika_hosted_thread_socket_tickets_active
  ON rika_hosted_thread_socket_tickets (ticket_digest, audience, expires_at)
  WHERE consumed_at IS NULL AND revoked_at IS NULL;
