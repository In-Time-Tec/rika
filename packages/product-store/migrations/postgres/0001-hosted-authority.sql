CREATE TYPE rika_hosted_executor_kind AS ENUM ('local_device', 'e2b');
CREATE TYPE rika_hosted_grant_role AS ENUM ('viewer', 'controller', 'operator', 'owner');
CREATE TYPE rika_hosted_executor_status AS ENUM ('online', 'draining', 'offline');
CREATE TYPE rika_hosted_presence_status AS ENUM ('viewing', 'controlling', 'away');

CREATE TABLE rika_hosted_organization_counters (
  organization_id TEXT PRIMARY KEY,
  next_commit_cursor BIGINT NOT NULL DEFAULT 1 CHECK (next_commit_cursor >= 1)
);

CREATE TABLE rika_hosted_projects (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(name) > 0),
  created_by_member_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (id, organization_id)
);

CREATE UNIQUE INDEX rika_hosted_projects_organization_name
  ON rika_hosted_projects (organization_id, lower(name));

CREATE TABLE rika_hosted_project_grants (
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  role rika_hosted_grant_role NOT NULL,
  granted_by_member_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (project_id, member_id),
  FOREIGN KEY (project_id, organization_id)
    REFERENCES rika_hosted_projects (id, organization_id) ON DELETE CASCADE
);

CREATE INDEX rika_hosted_project_grants_member
  ON rika_hosted_project_grants (organization_id, member_id, project_id);

CREATE TABLE rika_hosted_workspaces (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  created_by_member_id TEXT NOT NULL,
  executor_kind rika_hosted_executor_kind NOT NULL,
  inherit_project_grants BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (id, organization_id),
  UNIQUE (id, organization_id, project_id, executor_kind),
  FOREIGN KEY (project_id, organization_id)
    REFERENCES rika_hosted_projects (id, organization_id) ON DELETE RESTRICT,
  CHECK (executor_kind = 'e2b' OR inherit_project_grants = false)
);

CREATE INDEX rika_hosted_workspaces_project
  ON rika_hosted_workspaces (organization_id, project_id, created_at, id);

CREATE TABLE rika_hosted_threads (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  created_by_member_id TEXT NOT NULL,
  executor_kind rika_hosted_executor_kind NOT NULL,
  inherit_project_grants BOOLEAN NOT NULL,
  next_command_sequence BIGINT NOT NULL DEFAULT 1 CHECK (next_command_sequence >= 1),
  next_event_sequence BIGINT NOT NULL DEFAULT 1 CHECK (next_event_sequence >= 1),
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (id, organization_id),
  UNIQUE (id, organization_id, executor_kind),
  FOREIGN KEY (workspace_id, organization_id, project_id, executor_kind)
    REFERENCES rika_hosted_workspaces (id, organization_id, project_id, executor_kind) ON DELETE RESTRICT,
  CHECK (executor_kind = 'e2b' OR inherit_project_grants = false)
);

CREATE INDEX rika_hosted_threads_project
  ON rika_hosted_threads (organization_id, project_id, created_at, id);

CREATE TABLE rika_hosted_thread_grants (
  organization_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  role rika_hosted_grant_role NOT NULL,
  granted_by_member_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (thread_id, member_id),
  FOREIGN KEY (thread_id, organization_id)
    REFERENCES rika_hosted_threads (id, organization_id) ON DELETE CASCADE
);

CREATE INDEX rika_hosted_thread_grants_member
  ON rika_hosted_thread_grants (organization_id, member_id, thread_id);

CREATE TABLE rika_hosted_devices (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  display_name TEXT NOT NULL CHECK (length(display_name) > 0),
  public_key_fingerprint TEXT NOT NULL CHECK (length(public_key_fingerprint) > 0),
  created_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  UNIQUE (id, organization_id),
  UNIQUE (id, organization_id, member_id),
  UNIQUE (organization_id, public_key_fingerprint)
);

CREATE TABLE rika_hosted_clients (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  authenticated_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  UNIQUE (id, organization_id, member_id),
  FOREIGN KEY (device_id, organization_id, member_id)
    REFERENCES rika_hosted_devices (id, organization_id, member_id) ON DELETE RESTRICT,
  CHECK (expires_at > authenticated_at)
);

CREATE INDEX rika_hosted_clients_active
  ON rika_hosted_clients (organization_id, member_id, expires_at)
  WHERE revoked_at IS NULL;

CREATE TABLE rika_hosted_executor_instances (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  executor_kind rika_hosted_executor_kind NOT NULL,
  device_id TEXT,
  status rika_hosted_executor_status NOT NULL,
  connected_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL,
  UNIQUE (id, organization_id),
  UNIQUE (id, organization_id, executor_kind),
  FOREIGN KEY (device_id, organization_id)
    REFERENCES rika_hosted_devices (id, organization_id) ON DELETE RESTRICT,
  CHECK (
    (executor_kind = 'local_device' AND device_id IS NOT NULL)
    OR (executor_kind = 'e2b' AND device_id IS NULL)
  )
);

CREATE INDEX rika_hosted_executor_instances_available
  ON rika_hosted_executor_instances (organization_id, executor_kind, status, last_seen_at);

CREATE TABLE rika_hosted_executor_assignments (
  organization_id TEXT NOT NULL,
  thread_id TEXT PRIMARY KEY,
  executor_instance_id TEXT NOT NULL,
  executor_kind rika_hosted_executor_kind NOT NULL,
  lease_id TEXT NOT NULL,
  generation BIGINT NOT NULL CHECK (generation >= 1),
  acquired_at TIMESTAMPTZ NOT NULL,
  renewed_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  FOREIGN KEY (thread_id, organization_id, executor_kind)
    REFERENCES rika_hosted_threads (id, organization_id, executor_kind) ON DELETE CASCADE,
  FOREIGN KEY (executor_instance_id, organization_id, executor_kind)
    REFERENCES rika_hosted_executor_instances (id, organization_id, executor_kind) ON DELETE RESTRICT,
  CHECK (expires_at > renewed_at)
);

CREATE INDEX rika_hosted_executor_assignments_expiry
  ON rika_hosted_executor_assignments (expires_at, organization_id, thread_id);

CREATE TABLE rika_hosted_terminal_writer_leases (
  organization_id TEXT NOT NULL,
  thread_id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  lease_id TEXT NOT NULL,
  generation BIGINT NOT NULL CHECK (generation >= 1),
  acquired_at TIMESTAMPTZ NOT NULL,
  renewed_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  FOREIGN KEY (thread_id, organization_id)
    REFERENCES rika_hosted_threads (id, organization_id) ON DELETE CASCADE,
  FOREIGN KEY (client_id, organization_id, member_id)
    REFERENCES rika_hosted_clients (id, organization_id, member_id) ON DELETE CASCADE,
  CHECK (expires_at > renewed_at)
);

CREATE INDEX rika_hosted_terminal_writer_leases_expiry
  ON rika_hosted_terminal_writer_leases (expires_at, organization_id, thread_id);

CREATE TABLE rika_hosted_thread_commands (
  organization_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  actor JSONB NOT NULL CHECK (jsonb_typeof(actor) = 'object'),
  sequence BIGINT NOT NULL CHECK (sequence >= 1),
  commit_cursor BIGINT NOT NULL CHECK (commit_cursor >= 1),
  command JSONB NOT NULL CHECK (jsonb_typeof(command) = 'object'),
  admitted_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (thread_id, command_id),
  UNIQUE (thread_id, idempotency_key),
  UNIQUE (thread_id, organization_id, sequence),
  UNIQUE (organization_id, commit_cursor),
  FOREIGN KEY (thread_id, organization_id)
    REFERENCES rika_hosted_threads (id, organization_id) ON DELETE CASCADE,
  FOREIGN KEY (client_id, organization_id, member_id)
    REFERENCES rika_hosted_clients (id, organization_id, member_id) ON DELETE RESTRICT,
  CHECK (actor ->> '_tag' = 'AuthenticatedMember'),
  CHECK (actor ->> 'organizationId' = organization_id),
  CHECK (actor ->> 'memberId' = member_id),
  CHECK (actor ->> 'clientId' = client_id)
);

CREATE INDEX rika_hosted_thread_commands_sequence
  ON rika_hosted_thread_commands (organization_id, thread_id, sequence);

CREATE INDEX rika_hosted_thread_commands_cursor
  ON rika_hosted_thread_commands (organization_id, thread_id, commit_cursor);

CREATE TABLE rika_hosted_thread_events (
  organization_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  executor_instance_id TEXT NOT NULL,
  assignment_generation BIGINT NOT NULL CHECK (assignment_generation >= 1),
  sequence BIGINT NOT NULL CHECK (sequence >= 1),
  commit_cursor BIGINT NOT NULL CHECK (commit_cursor >= 1),
  command_sequence BIGINT,
  event JSONB NOT NULL CHECK (jsonb_typeof(event) = 'object'),
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (thread_id, event_id),
  UNIQUE (thread_id, idempotency_key),
  UNIQUE (thread_id, organization_id, sequence),
  UNIQUE (organization_id, commit_cursor),
  FOREIGN KEY (thread_id, organization_id)
    REFERENCES rika_hosted_threads (id, organization_id) ON DELETE CASCADE,
  FOREIGN KEY (executor_instance_id, organization_id)
    REFERENCES rika_hosted_executor_instances (id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (thread_id, organization_id, command_sequence)
    REFERENCES rika_hosted_thread_commands (thread_id, organization_id, sequence) ON DELETE RESTRICT
);

CREATE INDEX rika_hosted_thread_events_sequence
  ON rika_hosted_thread_events (organization_id, thread_id, sequence);

CREATE INDEX rika_hosted_thread_events_cursor
  ON rika_hosted_thread_events (organization_id, thread_id, commit_cursor);

CREATE TABLE rika_hosted_client_cursors (
  organization_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  commit_cursor BIGINT NOT NULL CHECK (commit_cursor >= 0),
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (thread_id, client_id),
  FOREIGN KEY (thread_id, organization_id)
    REFERENCES rika_hosted_threads (id, organization_id) ON DELETE CASCADE,
  FOREIGN KEY (client_id, organization_id, member_id)
    REFERENCES rika_hosted_clients (id, organization_id, member_id) ON DELETE CASCADE
);

CREATE TABLE rika_hosted_presence (
  organization_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  status rika_hosted_presence_status NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (thread_id, client_id),
  FOREIGN KEY (thread_id, organization_id)
    REFERENCES rika_hosted_threads (id, organization_id) ON DELETE CASCADE,
  FOREIGN KEY (client_id, organization_id, member_id)
    REFERENCES rika_hosted_clients (id, organization_id, member_id) ON DELETE CASCADE,
  CHECK (expires_at > last_seen_at)
);

CREATE INDEX rika_hosted_presence_expiry
  ON rika_hosted_presence (organization_id, thread_id, expires_at);

CREATE TABLE rika_hosted_local_workspace_bindings (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  root_path TEXT NOT NULL CHECK (length(root_path) > 0),
  workspace_fingerprint TEXT NOT NULL CHECK (length(workspace_fingerprint) > 0),
  executor_kind rika_hosted_executor_kind NOT NULL DEFAULT 'local_device'
    CHECK (executor_kind = 'local_device'),
  created_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL,
  UNIQUE (thread_id, device_id),
  FOREIGN KEY (thread_id, organization_id, executor_kind)
    REFERENCES rika_hosted_threads (id, organization_id, executor_kind) ON DELETE CASCADE,
  FOREIGN KEY (device_id, organization_id, member_id)
    REFERENCES rika_hosted_devices (id, organization_id, member_id) ON DELETE CASCADE
);

CREATE TABLE rika_hosted_checkpoints (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  executor_instance_id TEXT NOT NULL,
  assignment_generation BIGINT NOT NULL CHECK (assignment_generation >= 1),
  event_sequence BIGINT NOT NULL CHECK (event_sequence >= 0),
  baton_checkpoint_reference TEXT NOT NULL CHECK (length(baton_checkpoint_reference) > 0),
  metadata JSONB NOT NULL CHECK (jsonb_typeof(metadata) = 'object'),
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (thread_id, executor_instance_id, assignment_generation, event_sequence),
  FOREIGN KEY (thread_id, organization_id)
    REFERENCES rika_hosted_threads (id, organization_id) ON DELETE CASCADE,
  FOREIGN KEY (executor_instance_id, organization_id)
    REFERENCES rika_hosted_executor_instances (id, organization_id) ON DELETE RESTRICT
);

CREATE INDEX rika_hosted_checkpoints_latest
  ON rika_hosted_checkpoints (organization_id, thread_id, event_sequence DESC, created_at DESC);

CREATE TABLE rika_hosted_audit_events (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  actor_member_id TEXT NOT NULL,
  actor_client_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (length(action) > 0),
  resource_kind TEXT NOT NULL CHECK (length(resource_kind) > 0),
  resource_id TEXT NOT NULL CHECK (length(resource_id) > 0),
  commit_cursor BIGINT NOT NULL CHECK (commit_cursor >= 1),
  attributes JSONB NOT NULL CHECK (jsonb_typeof(attributes) = 'object'),
  occurred_at TIMESTAMPTZ NOT NULL,
  UNIQUE (organization_id, commit_cursor),
  FOREIGN KEY (actor_client_id, organization_id, actor_member_id)
    REFERENCES rika_hosted_clients (id, organization_id, member_id) ON DELETE RESTRICT
);

CREATE INDEX rika_hosted_audit_events_timeline
  ON rika_hosted_audit_events (organization_id, occurred_at DESC, id);

CREATE TABLE rika_hosted_credential_references (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  project_id TEXT,
  provider TEXT NOT NULL CHECK (length(provider) > 0),
  purpose TEXT NOT NULL CHECK (length(purpose) > 0),
  external_reference TEXT NOT NULL CHECK (length(external_reference) > 0),
  metadata JSONB NOT NULL CHECK (
    jsonb_typeof(metadata) = 'object'
    AND metadata::text !~* '"(api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret|private[_-]?key|authorization|cookie)"[[:space:]]*:'
  ),
  created_by_member_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (organization_id, provider, external_reference),
  FOREIGN KEY (project_id, organization_id)
    REFERENCES rika_hosted_projects (id, organization_id) ON DELETE CASCADE
);

CREATE FUNCTION rika_hosted_reject_thread_authority_change()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
    OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
    OR NEW.created_by_member_id IS DISTINCT FROM OLD.created_by_member_id
    OR NEW.executor_kind IS DISTINCT FROM OLD.executor_kind
    OR NEW.inherit_project_grants IS DISTINCT FROM OLD.inherit_project_grants
  THEN
    RAISE EXCEPTION 'thread authority fields are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER rika_hosted_threads_immutable_authority
BEFORE UPDATE ON rika_hosted_threads
FOR EACH ROW EXECUTE FUNCTION rika_hosted_reject_thread_authority_change();

CREATE FUNCTION rika_hosted_reject_workspace_authority_change()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
    OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.created_by_member_id IS DISTINCT FROM OLD.created_by_member_id
    OR NEW.executor_kind IS DISTINCT FROM OLD.executor_kind
    OR NEW.inherit_project_grants IS DISTINCT FROM OLD.inherit_project_grants
  THEN
    RAISE EXCEPTION 'workspace authority fields are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER rika_hosted_workspaces_immutable_authority
BEFORE UPDATE ON rika_hosted_workspaces
FOR EACH ROW EXECUTE FUNCTION rika_hosted_reject_workspace_authority_change();

CREATE FUNCTION rika_hosted_validate_terminal_input()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.command ->> '_tag' = 'TerminalInput' AND NOT EXISTS (
    SELECT 1
    FROM rika_hosted_terminal_writer_leases writer
    WHERE writer.organization_id = NEW.organization_id
      AND writer.thread_id = NEW.thread_id
      AND writer.member_id = NEW.member_id
      AND writer.client_id = NEW.client_id
      AND writer.lease_id = NEW.command ->> 'writerLeaseId'
      AND writer.generation = (NEW.command ->> 'writerGeneration')::BIGINT
      AND writer.expires_at > transaction_timestamp()
  ) THEN
    RAISE EXCEPTION 'terminal input requires the active writer lease' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER rika_hosted_thread_commands_terminal_writer
BEFORE INSERT ON rika_hosted_thread_commands
FOR EACH ROW EXECUTE FUNCTION rika_hosted_validate_terminal_input();

CREATE FUNCTION rika_hosted_validate_executor_fence()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM rika_hosted_executor_assignments assignment
    WHERE assignment.organization_id = NEW.organization_id
      AND assignment.thread_id = NEW.thread_id
      AND assignment.executor_instance_id = NEW.executor_instance_id
      AND assignment.generation = NEW.assignment_generation
      AND assignment.expires_at > transaction_timestamp()
  ) THEN
    RAISE EXCEPTION 'stale executor fencing generation' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER rika_hosted_thread_events_executor_fence
BEFORE INSERT ON rika_hosted_thread_events
FOR EACH ROW EXECUTE FUNCTION rika_hosted_validate_executor_fence();

CREATE TRIGGER rika_hosted_checkpoints_executor_fence
BEFORE INSERT ON rika_hosted_checkpoints
FOR EACH ROW EXECUTE FUNCTION rika_hosted_validate_executor_fence();
