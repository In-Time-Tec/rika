CREATE TYPE rika_hosted_executor_kind AS ENUM ('runner', 'orb');
CREATE TYPE rika_hosted_grant_role AS ENUM ('viewer', 'controller', 'operator', 'owner');
CREATE TYPE rika_hosted_presence_status AS ENUM ('viewing', 'controlling', 'away');
CREATE TYPE rika_hosted_assignment_lifecycle AS ENUM (
  'pending',
  'provisioning',
  'awaiting_bootstrap',
  'active',
  'paused',
  'terminated'
);

CREATE TABLE rika_hosted_owners (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('personal', 'organization')),
  user_id TEXT UNIQUE,
  organization_id TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  CHECK (
    (kind = 'personal' AND user_id IS NOT NULL AND organization_id IS NULL)
    OR (kind = 'organization' AND user_id IS NULL AND organization_id IS NOT NULL)
  ),
  FOREIGN KEY (user_id) REFERENCES "user" (id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id) REFERENCES "organization" (id) ON DELETE CASCADE
);

CREATE TABLE rika_hosted_owner_counters (
  owner_id TEXT PRIMARY KEY,
  FOREIGN KEY (owner_id) REFERENCES rika_hosted_owners (id) ON DELETE CASCADE,
  next_commit_cursor BIGINT NOT NULL DEFAULT 1 CHECK (next_commit_cursor >= 1)
);

CREATE TABLE rika_hosted_projects (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  FOREIGN KEY (owner_id) REFERENCES rika_hosted_owners (id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(name) > 0),
  created_by_user_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (id, owner_id)
);

CREATE UNIQUE INDEX rika_hosted_projects_owner_name
  ON rika_hosted_projects (owner_id, lower(name));

CREATE TABLE rika_hosted_project_grants (
  owner_id TEXT NOT NULL,
  FOREIGN KEY (owner_id) REFERENCES rika_hosted_owners (id) ON DELETE CASCADE,
  project_id TEXT NOT NULL,
  membership_id TEXT NOT NULL,
  role rika_hosted_grant_role NOT NULL,
  granted_by_user_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (project_id, membership_id),
  FOREIGN KEY (project_id, owner_id)
    REFERENCES rika_hosted_projects (id, owner_id) ON DELETE CASCADE
);

CREATE INDEX rika_hosted_project_grants_member
  ON rika_hosted_project_grants (owner_id, membership_id, project_id);

CREATE TABLE rika_hosted_workspaces (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  FOREIGN KEY (owner_id) REFERENCES rika_hosted_owners (id) ON DELETE CASCADE,
  project_id TEXT,
  created_by_user_id TEXT NOT NULL,
  executor_kind rika_hosted_executor_kind NOT NULL,
  inherit_project_grants BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (id, owner_id),
  UNIQUE (id, owner_id, project_id, executor_kind),
  FOREIGN KEY (project_id, owner_id)
    REFERENCES rika_hosted_projects (id, owner_id) ON DELETE RESTRICT,
  CHECK (executor_kind = 'orb' OR inherit_project_grants = false)
);

CREATE INDEX rika_hosted_workspaces_project
  ON rika_hosted_workspaces (owner_id, project_id, created_at, id);

CREATE TABLE rika_hosted_threads (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  FOREIGN KEY (owner_id) REFERENCES rika_hosted_owners (id) ON DELETE CASCADE,
  project_id TEXT,
  workspace_id TEXT NOT NULL,
  created_by_user_id TEXT NOT NULL,
  executor_kind rika_hosted_executor_kind NOT NULL,
  inherit_project_grants BOOLEAN NOT NULL,
  next_command_sequence BIGINT NOT NULL DEFAULT 1 CHECK (next_command_sequence >= 1),
  next_event_sequence BIGINT NOT NULL DEFAULT 1 CHECK (next_event_sequence >= 1),
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (id, owner_id),
  UNIQUE (id, owner_id, executor_kind),
  FOREIGN KEY (workspace_id, owner_id, project_id, executor_kind)
    REFERENCES rika_hosted_workspaces (id, owner_id, project_id, executor_kind) ON DELETE RESTRICT,
  CHECK (executor_kind = 'orb' OR inherit_project_grants = false)
);

CREATE INDEX rika_hosted_threads_project
  ON rika_hosted_threads (owner_id, project_id, created_at, id);

CREATE TABLE rika_hosted_thread_grants (
  owner_id TEXT NOT NULL,
  FOREIGN KEY (owner_id) REFERENCES rika_hosted_owners (id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL,
  membership_id TEXT NOT NULL,
  role rika_hosted_grant_role NOT NULL,
  granted_by_user_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (thread_id, membership_id),
  FOREIGN KEY (thread_id, owner_id)
    REFERENCES rika_hosted_threads (id, owner_id) ON DELETE CASCADE
);

CREATE INDEX rika_hosted_thread_grants_member
  ON rika_hosted_thread_grants (owner_id, membership_id, thread_id);

CREATE TABLE rika_hosted_devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  display_name TEXT NOT NULL CHECK (length(display_name) > 0),
  public_key_fingerprint TEXT NOT NULL CHECK (length(public_key_fingerprint) > 0),
  created_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  UNIQUE (id, user_id),
  UNIQUE (user_id, public_key_fingerprint)
);

CREATE TABLE rika_hosted_clients (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  authenticated_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  UNIQUE (id, user_id),
  FOREIGN KEY (device_id, user_id)
    REFERENCES rika_hosted_devices (id, user_id) ON DELETE RESTRICT,
  CHECK (expires_at > authenticated_at)
);

CREATE INDEX rika_hosted_clients_active
  ON rika_hosted_clients (user_id, expires_at)
  WHERE revoked_at IS NULL;

CREATE TABLE rika_hosted_executor_assignments (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  FOREIGN KEY (owner_id) REFERENCES rika_hosted_owners (id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL,
  executor_kind rika_hosted_executor_kind NOT NULL,
  placement JSONB NOT NULL CHECK (
    jsonb_typeof(placement) = 'object'
    AND placement ->> '_tag' IN ('RunnerPlacement', 'OrbPlacement')
  ),
  checkout JSONB CHECK (
    checkout IS NULL OR (
      jsonb_typeof(checkout) = 'object'
      AND length(checkout ->> 'repositoryId') > 0
      AND length(checkout ->> 'installationId') > 0
      AND length(checkout ->> 'owner') > 0
      AND length(checkout ->> 'name') > 0
      AND checkout ->> 'commitSha' ~* '^[a-f0-9]{40}$'
    )
  ),
  generation BIGINT NOT NULL CHECK (generation >= 1),
  revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
  last_lease_epoch BIGINT NOT NULL DEFAULT 0 CHECK (last_lease_epoch >= 0),
  lifecycle rika_hosted_assignment_lifecycle NOT NULL,
  provider_instance_id TEXT,
  bootstrap_digest TEXT,
  bootstrap_expires_at TIMESTAMPTZ,
  executor_instance_id TEXT,
  process_incarnation TEXT,
  session_digest TEXT,
  lease_epoch BIGINT CHECK (lease_epoch >= 1),
  lease_expires_at TIMESTAMPTZ,
  cursor_sequence BIGINT NOT NULL DEFAULT 0 CHECK (cursor_sequence >= 0),
  cursor_value TEXT NOT NULL DEFAULT '',
  latest_checkpoint_id TEXT,
  last_active_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  UNIQUE (thread_id),
  UNIQUE (id, owner_id),
  FOREIGN KEY (thread_id, owner_id, executor_kind)
    REFERENCES rika_hosted_threads (id, owner_id, executor_kind) ON DELETE CASCADE,
  CHECK (
    (executor_kind = 'runner' AND placement ->> '_tag' = 'RunnerPlacement')
    OR (executor_kind = 'orb' AND placement ->> '_tag' = 'OrbPlacement')
  ),
  CHECK (lease_epoch IS NULL OR last_lease_epoch >= lease_epoch),
  CHECK (
    (lifecycle = 'pending'
      AND provider_instance_id IS NULL AND bootstrap_digest IS NULL AND bootstrap_expires_at IS NULL
      AND executor_instance_id IS NULL AND process_incarnation IS NULL AND session_digest IS NULL
      AND lease_epoch IS NULL AND lease_expires_at IS NULL)
    OR (lifecycle = 'provisioning'
      AND bootstrap_digest IS NOT NULL AND bootstrap_expires_at IS NOT NULL
      AND executor_instance_id IS NULL AND process_incarnation IS NULL AND session_digest IS NULL
      AND lease_epoch IS NULL AND lease_expires_at IS NULL)
    OR (lifecycle = 'awaiting_bootstrap'
      AND provider_instance_id IS NOT NULL AND bootstrap_digest IS NOT NULL AND bootstrap_expires_at IS NOT NULL
      AND executor_instance_id IS NULL AND process_incarnation IS NULL AND session_digest IS NULL
      AND lease_epoch IS NULL AND lease_expires_at IS NULL)
    OR (lifecycle = 'active'
      AND provider_instance_id IS NOT NULL AND bootstrap_digest IS NULL AND bootstrap_expires_at IS NULL
      AND executor_instance_id IS NOT NULL AND process_incarnation IS NOT NULL AND session_digest IS NOT NULL
      AND lease_epoch IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (lifecycle = 'paused'
      AND provider_instance_id IS NOT NULL AND bootstrap_digest IS NULL AND bootstrap_expires_at IS NULL
      AND executor_instance_id IS NULL AND process_incarnation IS NULL AND session_digest IS NULL
      AND lease_epoch IS NULL AND lease_expires_at IS NULL)
    OR (lifecycle = 'terminated'
      AND bootstrap_digest IS NULL AND bootstrap_expires_at IS NULL
      AND executor_instance_id IS NULL AND process_incarnation IS NULL AND session_digest IS NULL
      AND lease_epoch IS NULL AND lease_expires_at IS NULL)
  )
);

CREATE INDEX rika_hosted_executor_assignments_expiry
  ON rika_hosted_executor_assignments (lease_expires_at, owner_id, thread_id)
  WHERE lifecycle = 'active';

CREATE INDEX rika_hosted_executor_assignments_provider
  ON rika_hosted_executor_assignments (executor_kind, lifecycle, provider_instance_id);

CREATE TABLE rika_hosted_terminal_writer_leases (
  owner_id TEXT NOT NULL,
  FOREIGN KEY (owner_id) REFERENCES rika_hosted_owners (id) ON DELETE CASCADE,
  thread_id TEXT PRIMARY KEY,
  actor JSONB NOT NULL CHECK (jsonb_typeof(actor) = 'object'),
  lease_id TEXT NOT NULL,
  generation BIGINT NOT NULL CHECK (generation >= 1),
  acquired_at TIMESTAMPTZ NOT NULL,
  renewed_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  FOREIGN KEY (thread_id, owner_id)
    REFERENCES rika_hosted_threads (id, owner_id) ON DELETE CASCADE,
  CHECK (expires_at > renewed_at)
);

CREATE INDEX rika_hosted_terminal_writer_leases_expiry
  ON rika_hosted_terminal_writer_leases (expires_at, owner_id, thread_id);

CREATE TABLE rika_hosted_thread_commands (
  owner_id TEXT NOT NULL,
  FOREIGN KEY (owner_id) REFERENCES rika_hosted_owners (id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  actor JSONB NOT NULL CHECK (jsonb_typeof(actor) = 'object'),
  sequence BIGINT NOT NULL CHECK (sequence >= 1),
  commit_cursor BIGINT NOT NULL CHECK (commit_cursor >= 1),
  command JSONB NOT NULL CHECK (jsonb_typeof(command) = 'object'),
  admitted_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (thread_id, command_id),
  UNIQUE (thread_id, idempotency_key),
  UNIQUE (thread_id, owner_id, sequence),
  UNIQUE (owner_id, commit_cursor),
  FOREIGN KEY (thread_id, owner_id)
    REFERENCES rika_hosted_threads (id, owner_id) ON DELETE CASCADE
);

CREATE INDEX rika_hosted_thread_commands_sequence
  ON rika_hosted_thread_commands (owner_id, thread_id, sequence);

CREATE INDEX rika_hosted_thread_commands_cursor
  ON rika_hosted_thread_commands (owner_id, thread_id, commit_cursor);

CREATE TABLE rika_hosted_thread_events (
  owner_id TEXT NOT NULL,
  FOREIGN KEY (owner_id) REFERENCES rika_hosted_owners (id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  executor_instance_id TEXT NOT NULL,
  assignment_id TEXT NOT NULL,
  assignment_generation BIGINT NOT NULL CHECK (assignment_generation >= 1),
  lease_epoch BIGINT NOT NULL CHECK (lease_epoch >= 1),
  sequence BIGINT NOT NULL CHECK (sequence >= 1),
  commit_cursor BIGINT NOT NULL CHECK (commit_cursor >= 1),
  command_sequence BIGINT,
  event JSONB NOT NULL CHECK (jsonb_typeof(event) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (thread_id, event_id),
  UNIQUE (thread_id, idempotency_key),
  UNIQUE (thread_id, owner_id, sequence),
  UNIQUE (owner_id, commit_cursor),
  FOREIGN KEY (thread_id, owner_id)
    REFERENCES rika_hosted_threads (id, owner_id) ON DELETE CASCADE,
  FOREIGN KEY (assignment_id, owner_id)
    REFERENCES rika_hosted_executor_assignments (id, owner_id) ON DELETE RESTRICT,
  FOREIGN KEY (thread_id, owner_id, command_sequence)
    REFERENCES rika_hosted_thread_commands (thread_id, owner_id, sequence) ON DELETE RESTRICT
);

CREATE INDEX rika_hosted_thread_events_sequence
  ON rika_hosted_thread_events (owner_id, thread_id, sequence);

CREATE INDEX rika_hosted_thread_events_cursor
  ON rika_hosted_thread_events (owner_id, thread_id, commit_cursor);

CREATE TABLE rika_hosted_client_cursors (
  owner_id TEXT NOT NULL,
  FOREIGN KEY (owner_id) REFERENCES rika_hosted_owners (id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL,
  actor JSONB NOT NULL CHECK (jsonb_typeof(actor) = 'object'),
  commit_cursor BIGINT NOT NULL CHECK (commit_cursor >= 0),
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (thread_id, actor),
  FOREIGN KEY (thread_id, owner_id)
    REFERENCES rika_hosted_threads (id, owner_id) ON DELETE CASCADE
);

CREATE TABLE rika_hosted_presence (
  owner_id TEXT NOT NULL,
  FOREIGN KEY (owner_id) REFERENCES rika_hosted_owners (id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL,
  actor JSONB NOT NULL CHECK (jsonb_typeof(actor) = 'object'),
  status rika_hosted_presence_status NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (thread_id, actor),
  FOREIGN KEY (thread_id, owner_id)
    REFERENCES rika_hosted_threads (id, owner_id) ON DELETE CASCADE,
  CHECK (expires_at > last_seen_at)
);

CREATE INDEX rika_hosted_presence_expiry
  ON rika_hosted_presence (owner_id, thread_id, expires_at);


CREATE TABLE rika_hosted_checkpoints (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  FOREIGN KEY (owner_id) REFERENCES rika_hosted_owners (id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL,
  assignment_id TEXT NOT NULL,
  executor_instance_id TEXT NOT NULL,
  assignment_generation BIGINT NOT NULL CHECK (assignment_generation >= 1),
  lease_epoch BIGINT NOT NULL CHECK (lease_epoch >= 1),
  object_key TEXT NOT NULL CHECK (length(object_key) > 0),
  content_digest TEXT NOT NULL CHECK (content_digest ~ '^sha256:[a-f0-9]{64}$'),
  size_bytes BIGINT NOT NULL CHECK (size_bytes > 0),
  format TEXT NOT NULL CHECK (format = 'tar.zst'),
  cursor_sequence BIGINT NOT NULL CHECK (cursor_sequence >= 0),
  cursor_value TEXT NOT NULL,
  metadata JSONB NOT NULL CHECK (
    jsonb_typeof(metadata) = 'object'
    AND metadata::text !~* '"(api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret|private[_-]?key|authorization|cookie)"[[:space:]]*:'
  ),
  verified_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  FOREIGN KEY (thread_id, owner_id)
    REFERENCES rika_hosted_threads (id, owner_id) ON DELETE CASCADE,
  FOREIGN KEY (assignment_id, owner_id)
    REFERENCES rika_hosted_executor_assignments (id, owner_id) ON DELETE RESTRICT
);

CREATE INDEX rika_hosted_checkpoints_latest
  ON rika_hosted_checkpoints (owner_id, thread_id, cursor_sequence DESC, verified_at DESC);

CREATE TABLE rika_hosted_audit_events (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  FOREIGN KEY (owner_id) REFERENCES rika_hosted_owners (id) ON DELETE CASCADE,
  actor JSONB NOT NULL CHECK (jsonb_typeof(actor) = 'object'),
  action TEXT NOT NULL CHECK (length(action) > 0),
  resource_kind TEXT NOT NULL CHECK (length(resource_kind) > 0),
  resource_id TEXT NOT NULL CHECK (length(resource_id) > 0),
  commit_cursor BIGINT NOT NULL CHECK (commit_cursor >= 1),
  attributes JSONB NOT NULL CHECK (jsonb_typeof(attributes) = 'object'),
  occurred_at TIMESTAMPTZ NOT NULL,
  UNIQUE (owner_id, commit_cursor)
);

CREATE INDEX rika_hosted_audit_events_timeline
  ON rika_hosted_audit_events (owner_id, occurred_at DESC, id);

CREATE TABLE rika_hosted_credential_references (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  FOREIGN KEY (owner_id) REFERENCES rika_hosted_owners (id) ON DELETE CASCADE,
  project_id TEXT,
  provider TEXT NOT NULL CHECK (length(provider) > 0),
  purpose TEXT NOT NULL CHECK (length(purpose) > 0),
  external_reference TEXT NOT NULL CHECK (length(external_reference) > 0),
  metadata JSONB NOT NULL CHECK (
    jsonb_typeof(metadata) = 'object'
    AND metadata::text !~* '"(api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret|private[_-]?key|authorization|cookie)"[[:space:]]*:'
  ),
  created_by_user_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (owner_id, provider, external_reference),
  FOREIGN KEY (project_id, owner_id)
    REFERENCES rika_hosted_projects (id, owner_id) ON DELETE CASCADE
);

CREATE FUNCTION rika_hosted_reject_thread_authority_change()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.owner_id IS DISTINCT FROM OLD.owner_id
    OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
    OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
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
  IF NEW.owner_id IS DISTINCT FROM OLD.owner_id
    OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
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
    WHERE writer.owner_id = NEW.owner_id
      AND writer.thread_id = NEW.thread_id
      AND writer.actor = NEW.actor
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
    WHERE assignment.owner_id = NEW.owner_id
      AND assignment.thread_id = NEW.thread_id
      AND assignment.id = NEW.assignment_id
      AND assignment.executor_instance_id = NEW.executor_instance_id
      AND assignment.generation = NEW.assignment_generation
      AND assignment.lease_epoch = NEW.lease_epoch
      AND assignment.lifecycle = 'active'
      AND assignment.lease_expires_at > transaction_timestamp()
  ) THEN
    RAISE EXCEPTION 'stale executor fence' USING ERRCODE = '55000';
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

CREATE FUNCTION rika_hosted_actor_matches_owner(actor JSONB, expected_owner_id TEXT)
RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT jsonb_typeof(actor) = 'object'
    AND EXISTS (
      SELECT 1
      FROM rika_hosted_clients client
      JOIN rika_hosted_devices device ON device.id = client.device_id AND device.user_id = client.user_id
      WHERE client.id = actor ->> 'clientId'
        AND device.id = actor ->> 'deviceId'
        AND client.user_id = actor ->> 'userId'
    )
    AND (
    (
      actor ->> '_tag' = 'PersonalActor'
      AND actor -> 'owner' ->> '_tag' = 'PersonalOwner'
      AND actor -> 'owner' ->> 'userId' = actor ->> 'userId'
      AND EXISTS (
        SELECT 1 FROM rika_hosted_owners owner
        WHERE owner.id = expected_owner_id
          AND owner.kind = 'personal'
          AND owner.user_id = actor ->> 'userId'
      )
    ) OR (
      actor ->> '_tag' = 'OrganizationActor'
      AND actor -> 'owner' ->> '_tag' = 'OrganizationOwner'
      AND actor ? 'membershipId'
      AND EXISTS (
        SELECT 1
        FROM rika_hosted_owners owner
        JOIN "member" membership ON membership.organization_id = owner.organization_id
        WHERE owner.id = expected_owner_id
          AND owner.kind = 'organization'
          AND owner.organization_id = actor -> 'owner' ->> 'organizationId'
          AND membership.id = actor ->> 'membershipId'
          AND membership.user_id = actor ->> 'userId'
      )
    )
  )
$$;

ALTER TABLE rika_hosted_terminal_writer_leases ADD CHECK (rika_hosted_actor_matches_owner(actor, owner_id));
ALTER TABLE rika_hosted_thread_commands ADD CHECK (rika_hosted_actor_matches_owner(actor, owner_id));
ALTER TABLE rika_hosted_client_cursors ADD CHECK (rika_hosted_actor_matches_owner(actor, owner_id));
ALTER TABLE rika_hosted_presence ADD CHECK (rika_hosted_actor_matches_owner(actor, owner_id));
ALTER TABLE rika_hosted_audit_events ADD CHECK (rika_hosted_actor_matches_owner(actor, owner_id));

CREATE FUNCTION rika_hosted_validate_organization_grant()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM rika_hosted_owners owner
    JOIN "member" membership ON membership.organization_id = owner.organization_id
    WHERE owner.id = NEW.owner_id
      AND owner.kind = 'organization'
      AND membership.id = NEW.membership_id
  ) THEN
    RAISE EXCEPTION 'grants require membership in the organization owner' USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER rika_hosted_project_grants_organization_membership
BEFORE INSERT OR UPDATE ON rika_hosted_project_grants
FOR EACH ROW EXECUTE FUNCTION rika_hosted_validate_organization_grant();

CREATE TRIGGER rika_hosted_thread_grants_organization_membership
BEFORE INSERT OR UPDATE ON rika_hosted_thread_grants
FOR EACH ROW EXECUTE FUNCTION rika_hosted_validate_organization_grant();

CREATE FUNCTION rika_hosted_validate_thread_workspace_project()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM rika_hosted_workspaces workspace
    WHERE workspace.id = NEW.workspace_id
      AND workspace.owner_id = NEW.owner_id
      AND workspace.project_id IS NOT DISTINCT FROM NEW.project_id
      AND workspace.executor_kind = NEW.executor_kind
  ) THEN
    RAISE EXCEPTION 'thread and workspace project authority must match' USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER rika_hosted_threads_workspace_project_authority
BEFORE INSERT OR UPDATE ON rika_hosted_threads
FOR EACH ROW EXECUTE FUNCTION rika_hosted_validate_thread_workspace_project();
