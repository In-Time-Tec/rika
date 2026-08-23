CREATE TABLE rika_hosted_git_identities (
  owner_id TEXT PRIMARY KEY REFERENCES rika_hosted_owners (id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 256),
  email TEXT NOT NULL CHECK (
    length(email) BETWEEN 3 AND 320 AND email ~ '^[^[:space:]@]+@[^[:space:]@]+$'
  ),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp()
);

CREATE TABLE rika_hosted_project_repositories (
  project_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  installation_account_id TEXT NOT NULL,
  installation_account_login TEXT NOT NULL CHECK (length(installation_account_login) > 0),
  installation_account_type TEXT NOT NULL CHECK (installation_account_type IN ('User', 'Organization', 'Enterprise')),
  repository_owner TEXT NOT NULL CHECK (length(repository_owner) > 0),
  repository_name TEXT NOT NULL CHECK (length(repository_name) > 0),
  default_ref TEXT NOT NULL CHECK (length(default_ref) > 0),
  private BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  FOREIGN KEY (project_id, owner_id) REFERENCES rika_hosted_projects (id, owner_id) ON DELETE CASCADE,
  UNIQUE (owner_id, repository_id)
);

ALTER TABLE rika_hosted_executor_assignments
  DROP CONSTRAINT rika_hosted_executor_assignments_checkout_check,
  ADD CONSTRAINT rika_hosted_executor_assignments_checkout_check CHECK (
    checkout IS NULL OR (executor_kind = 'orb'
      AND checkout ?& ARRAY['ownerId', 'projectId', 'repositoryId', 'installationId', 'owner', 'name',
        'ref', 'commitSha', 'private', 'gitIdentity']
      AND jsonb_typeof(checkout) = 'object'
      AND checkout ->> 'ownerId' = owner_id
      AND length(checkout ->> 'projectId') > 0
      AND length(checkout ->> 'repositoryId') > 0
      AND length(checkout ->> 'installationId') > 0
      AND length(checkout ->> 'owner') > 0
      AND length(checkout ->> 'name') > 0
      AND length(checkout ->> 'ref') > 0
      AND checkout ->> 'commitSha' ~ '^[a-f0-9]{40}$'
      AND jsonb_typeof(checkout -> 'private') = 'boolean'
      AND jsonb_typeof(checkout -> 'gitIdentity') = 'object'
      AND checkout -> 'gitIdentity' ?& ARRAY['name', 'email']
      AND length(checkout -> 'gitIdentity' ->> 'name') BETWEEN 1 AND 256
      AND checkout -> 'gitIdentity' ->> 'email' ~ '^[^[:space:]@]+@[^[:space:]@]+$'
    )
  );

CREATE FUNCTION rika_validate_assignment_checkout() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  bound_project_id TEXT;
  bound_repository rika_hosted_project_repositories%ROWTYPE;
BEGIN
  IF NEW.executor_kind <> 'orb' THEN
    RETURN NEW;
  END IF;

  SELECT project_id INTO bound_project_id
  FROM rika_hosted_threads
  WHERE id = NEW.thread_id AND owner_id = NEW.owner_id;

  IF bound_project_id IS NULL THEN
    IF NEW.checkout IS NOT NULL THEN
      RAISE EXCEPTION 'no-Project workspace cannot have a repository checkout';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.checkout IS NULL THEN
    RAISE EXCEPTION 'Project workspace requires a repository checkout';
  END IF;

  SELECT * INTO bound_repository
  FROM rika_hosted_project_repositories
  WHERE project_id = bound_project_id AND owner_id = NEW.owner_id;

  IF NOT FOUND
    OR NEW.checkout ->> 'projectId' <> bound_project_id
    OR NEW.checkout ->> 'repositoryId' <> bound_repository.repository_id
    OR NEW.checkout ->> 'installationId' <> bound_repository.installation_id
    OR NEW.checkout ->> 'owner' <> bound_repository.repository_owner
    OR NEW.checkout ->> 'name' <> bound_repository.repository_name
    OR (NEW.checkout ->> 'private')::boolean <> bound_repository.private
  THEN
    RAISE EXCEPTION 'repository checkout does not match the authorized Project repository';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER rika_hosted_executor_assignments_checkout
  BEFORE INSERT OR UPDATE OF checkout, owner_id, thread_id
  ON rika_hosted_executor_assignments
  FOR EACH ROW EXECUTE FUNCTION rika_validate_assignment_checkout();

CREATE TYPE rika_hosted_preparation_state AS ENUM ('preparing', 'ready', 'failed');
CREATE TYPE rika_hosted_preparation_phase AS ENUM ('checkout', 'setup', 'resume', 'capabilities');

CREATE TABLE rika_hosted_workspace_preparations (
  assignment_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  generation BIGINT NOT NULL CHECK (generation >= 1),
  lease_epoch BIGINT NOT NULL CHECK (lease_epoch >= 1),
  attempt INTEGER NOT NULL CHECK (attempt >= 1),
  state rika_hosted_preparation_state NOT NULL,
  phase rika_hosted_preparation_phase NOT NULL,
  evidence JSONB,
  failure JSONB,
  started_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (assignment_id, generation),
  FOREIGN KEY (assignment_id, owner_id) REFERENCES rika_hosted_executor_assignments (id, owner_id) ON DELETE CASCADE,
  CHECK (
    (state = 'preparing' AND evidence IS NULL AND failure IS NULL)
    OR (state = 'ready' AND evidence IS NOT NULL AND failure IS NULL)
    OR (state = 'failed' AND evidence IS NULL AND failure IS NOT NULL)
  ),
  CHECK (evidence IS NULL OR octet_length(evidence::text) <= 16384),
  CHECK (failure IS NULL OR octet_length(failure::text) <= 4096)
);

CREATE TABLE rika_hosted_workspace_preparation_output (
  assignment_id TEXT NOT NULL,
  generation BIGINT NOT NULL,
  sequence BIGSERIAL,
  attempt INTEGER NOT NULL CHECK (attempt >= 1),
  phase rika_hosted_preparation_phase NOT NULL,
  stream TEXT NOT NULL CHECK (stream IN ('stdout', 'stderr')),
  text TEXT NOT NULL CHECK (octet_length(text) <= 16384),
  redacted BOOLEAN NOT NULL CHECK (redacted),
  truncated BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (assignment_id, generation, sequence),
  FOREIGN KEY (assignment_id, generation)
    REFERENCES rika_hosted_workspace_preparations (assignment_id, generation) ON DELETE CASCADE
);

CREATE INDEX rika_hosted_workspace_preparation_output_bounded
  ON rika_hosted_workspace_preparation_output (assignment_id, generation, sequence DESC);
