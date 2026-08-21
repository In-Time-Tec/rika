CREATE TYPE rika_hosted_repository_publication_state AS ENUM (
  'approved',
  'pushing',
  'pushed',
  'completed',
  'failed',
  'unknown'
);

CREATE TABLE rika_hosted_repository_publications (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  actor JSONB NOT NULL CHECK (jsonb_typeof(actor) = 'object'),
  assignment_id TEXT NOT NULL,
  assignment_generation BIGINT NOT NULL CHECK (assignment_generation >= 1),
  lease_epoch BIGINT NOT NULL CHECK (lease_epoch >= 1),
  workspace_id TEXT NOT NULL CHECK (length(workspace_id) > 0),
  authorization_checkpoint_id TEXT NOT NULL,
  authorization_digest TEXT NOT NULL CHECK (authorization_digest ~ '^sha256:[a-f0-9]{64}$'),
  source_branch TEXT NOT NULL CHECK (source_branch ~ '^rika/[A-Za-z0-9._/-]+$'),
  source_ref TEXT NOT NULL CHECK (source_ref = 'refs/heads/' || source_branch),
  source_commit_sha TEXT NOT NULL CHECK (source_commit_sha ~ '^[a-f0-9]{40}$'),
  target_ref TEXT NOT NULL CHECK (length(target_ref) > 0),
  target_commit_sha TEXT NOT NULL CHECK (target_commit_sha ~ '^[a-f0-9]{40}$'),
  target_protected BOOLEAN NOT NULL,
  pull_request_title TEXT NOT NULL CHECK (length(pull_request_title) BETWEEN 1 AND 256),
  pull_request_body TEXT NOT NULL CHECK (length(pull_request_body) <= 65536),
  state rika_hosted_repository_publication_state NOT NULL,
  credential_authorized_at TIMESTAMPTZ,
  push_result JSONB,
  pull_request_result JSONB,
  approved_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CHECK (rika_hosted_actor_matches_owner(actor, owner_id)),
  UNIQUE (owner_id, thread_id, idempotency_key),
  FOREIGN KEY (thread_id, owner_id) REFERENCES rika_hosted_threads (id, owner_id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, owner_id) REFERENCES rika_hosted_projects (id, owner_id) ON DELETE CASCADE,
  FOREIGN KEY (assignment_id, owner_id)
    REFERENCES rika_hosted_executor_assignments (id, owner_id) ON DELETE RESTRICT,
  CHECK ((state = 'approved' AND credential_authorized_at IS NULL AND push_result IS NULL)
    OR (state = 'pushing' AND credential_authorized_at IS NOT NULL AND push_result IS NULL)
    OR (state = 'pushed' AND credential_authorized_at IS NOT NULL AND push_result IS NOT NULL)
    OR (state = 'completed' AND credential_authorized_at IS NOT NULL
      AND push_result IS NOT NULL AND pull_request_result IS NOT NULL)
    OR (state IN ('failed', 'unknown')))
);

CREATE FUNCTION rika_hosted_reject_repository_publication_authority_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'repository publication authority is immutable';
END;
$$;

CREATE TRIGGER rika_hosted_repository_publication_authority_immutable
BEFORE UPDATE OF idempotency_key, owner_id, thread_id, project_id, repository_id, actor,
  assignment_id, assignment_generation, lease_epoch, workspace_id,
  authorization_checkpoint_id, authorization_digest, source_branch, source_ref, source_commit_sha,
  target_ref, target_commit_sha, target_protected, pull_request_title, pull_request_body, approved_at
ON rika_hosted_repository_publications
FOR EACH ROW EXECUTE FUNCTION rika_hosted_reject_repository_publication_authority_mutation();

CREATE TABLE rika_hosted_repository_publication_audit (
  sequence BIGSERIAL PRIMARY KEY,
  publication_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  actor JSONB NOT NULL CHECK (jsonb_typeof(actor) = 'object'),
  action TEXT NOT NULL CHECK (action IN (
    'approved',
    'branch-push-credential-authorized',
    'branch-push-credential-failed',
    'branch-push-succeeded',
    'branch-push-failed',
    'branch-push-unknown',
    'pull-request-succeeded',
    'pull-request-failed'
  )),
  authority JSONB NOT NULL CHECK (jsonb_typeof(authority) = 'object'),
  fence JSONB NOT NULL CHECK (jsonb_typeof(fence) = 'object'),
  result JSONB NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  CHECK (rika_hosted_actor_matches_owner(actor, owner_id)),
  CHECK ((authority || fence || result)::text
    !~* '"(api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret|private[_-]?key|authorization|cookie)"[[:space:]]*:')
);

CREATE INDEX rika_hosted_repository_publication_audit_lookup
  ON rika_hosted_repository_publication_audit (publication_id, sequence);

CREATE FUNCTION rika_hosted_reject_repository_publication_audit_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'repository publication audit is append-only';
END;
$$;

CREATE TRIGGER rika_hosted_repository_publication_audit_append_only
BEFORE UPDATE OR DELETE ON rika_hosted_repository_publication_audit
FOR EACH ROW EXECUTE FUNCTION rika_hosted_reject_repository_publication_audit_mutation();
