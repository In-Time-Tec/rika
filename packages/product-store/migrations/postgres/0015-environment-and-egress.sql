CREATE TABLE rika_hosted_environment_values (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES rika_hosted_owners(id) ON DELETE CASCADE,
  project_id TEXT,
  scope TEXT NOT NULL CHECK (scope IN ('personal', 'organization', 'project')),
  scope_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (name ~ '^[A-Za-z_][A-Za-z0-9_]{0,127}$'),
  classification TEXT NOT NULL CHECK (classification IN ('plain', 'secret')),
  phases TEXT[] NOT NULL CHECK (
    cardinality(phases) > 0
    AND cardinality(phases) <= 2
    AND phases <@ ARRAY['setup', 'runtime']::TEXT[]
    AND (cardinality(phases) = 1 OR phases[1] <> phases[2])
  ),
  revision BIGINT NOT NULL CHECK (revision > 0),
  value_digest TEXT NOT NULL CHECK (value_digest ~ '^sha256:[a-f0-9]{64}$'),
  state TEXT NOT NULL CHECK (state IN ('active', 'revoked')),
  key_version INTEGER,
  nonce BYTEA,
  ciphertext BYTEA,
  authentication_tag BYTEA,
  created_by_user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
  updated_by_user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  revoked_at TIMESTAMPTZ,
  UNIQUE (owner_id, scope, scope_id, name),
  FOREIGN KEY (project_id, owner_id) REFERENCES rika_hosted_projects(id, owner_id) ON DELETE CASCADE,
  CHECK (updated_at >= created_at),
  CHECK ((scope = 'project') = (project_id IS NOT NULL)),
  CHECK (
    (state = 'active'
      AND key_version = 1
      AND octet_length(nonce) = 12
      AND octet_length(ciphertext) > 0
      AND octet_length(authentication_tag) = 16
      AND revoked_at IS NULL)
    OR
    (state = 'revoked'
      AND key_version IS NULL
      AND nonce IS NULL
      AND ciphertext IS NULL
      AND authentication_tag IS NULL
      AND revoked_at IS NOT NULL)
  )
);

CREATE INDEX rika_hosted_environment_values_resolution
  ON rika_hosted_environment_values(owner_id, scope, scope_id, name)
  WHERE state = 'active';

CREATE TABLE rika_hosted_organization_environment_policy (
  owner_id TEXT PRIMARY KEY REFERENCES rika_hosted_owners(id) ON DELETE CASCADE,
  personal_overrides BOOLEAN NOT NULL DEFAULT true,
  updated_by_user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp()
);

CREATE TABLE rika_hosted_source_environment_approvals (
  id BIGSERIAL PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES rika_hosted_owners(id) ON DELETE CASCADE,
  project_id TEXT,
  source_owner TEXT NOT NULL CHECK (length(source_owner) > 0),
  source_commit_sha TEXT NOT NULL CHECK (source_commit_sha ~* '^[a-f0-9]{40}$'),
  phase TEXT NOT NULL CHECK (phase IN ('setup', 'runtime')),
  approved_by_user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
  approved_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  revoked_at TIMESTAMPTZ,
  FOREIGN KEY (project_id, owner_id) REFERENCES rika_hosted_projects(id, owner_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX rika_hosted_project_source_environment_approvals
  ON rika_hosted_source_environment_approvals(
    owner_id,
    project_id,
    lower(source_owner),
    lower(source_commit_sha),
    phase
  )
  WHERE project_id IS NOT NULL;

CREATE UNIQUE INDEX rika_hosted_owner_source_environment_approvals
  ON rika_hosted_source_environment_approvals(owner_id, lower(source_owner), lower(source_commit_sha), phase)
  WHERE project_id IS NULL;

CREATE TABLE rika_hosted_phase_egress_policy (
  owner_id TEXT NOT NULL REFERENCES rika_hosted_owners(id) ON DELETE CASCADE,
  project_id TEXT,
  phase TEXT NOT NULL CHECK (phase IN ('setup', 'runtime')),
  allowlist TEXT[] NOT NULL DEFAULT '{}',
  updated_by_user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  FOREIGN KEY (project_id, owner_id) REFERENCES rika_hosted_projects(id, owner_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX rika_hosted_project_phase_egress_policy
  ON rika_hosted_phase_egress_policy(owner_id, project_id, phase)
  WHERE project_id IS NOT NULL;

CREATE UNIQUE INDEX rika_hosted_owner_phase_egress_policy
  ON rika_hosted_phase_egress_policy(owner_id, phase)
  WHERE project_id IS NULL;

CREATE FUNCTION rika_hosted_validate_environment_scope()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.scope = 'personal' AND NOT EXISTS (
    SELECT 1 FROM rika_hosted_owners owner_record
    LEFT JOIN "member" membership ON membership.organization_id = owner_record.organization_id
      AND membership.user_id = NEW.scope_id
    WHERE owner_record.id = NEW.owner_id
      AND ((owner_record.kind = 'personal' AND owner_record.user_id = NEW.scope_id)
        OR (owner_record.kind = 'organization' AND membership.id IS NOT NULL))
  ) THEN
    RAISE EXCEPTION 'personal environment scope is outside owner authority' USING ERRCODE = '23503';
  END IF;
  IF NEW.scope = 'organization' AND NOT EXISTS (
    SELECT 1 FROM rika_hosted_owners owner_record
    WHERE owner_record.id = NEW.owner_id AND owner_record.kind = 'organization'
      AND owner_record.id = NEW.scope_id
  ) THEN
    RAISE EXCEPTION 'organization environment scope is outside owner authority' USING ERRCODE = '23503';
  END IF;
  IF NEW.scope = 'project' AND NOT EXISTS (
    SELECT 1 FROM rika_hosted_projects project
    WHERE project.id = NEW.scope_id AND project.id = NEW.project_id AND project.owner_id = NEW.owner_id
  ) THEN
    RAISE EXCEPTION 'project environment scope is outside owner authority' USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER rika_hosted_environment_values_scope_authority
BEFORE INSERT OR UPDATE ON rika_hosted_environment_values
FOR EACH ROW EXECUTE FUNCTION rika_hosted_validate_environment_scope();

CREATE FUNCTION rika_hosted_validate_organization_environment_policy()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM rika_hosted_owners owner_record
    WHERE owner_record.id = NEW.owner_id AND owner_record.kind = 'organization'
  ) THEN
    RAISE EXCEPTION 'environment policy requires an organization owner' USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER rika_hosted_organization_environment_policy_authority
BEFORE INSERT OR UPDATE ON rika_hosted_organization_environment_policy
FOR EACH ROW EXECUTE FUNCTION rika_hosted_validate_organization_environment_policy();
