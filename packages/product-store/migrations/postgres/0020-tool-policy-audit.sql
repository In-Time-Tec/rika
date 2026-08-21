CREATE TABLE rika_hosted_tool_audit_records (
  sequence BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  audit_group_id TEXT NOT NULL CHECK (audit_group_id ~ '^[a-f0-9]{64}$'),
  phase TEXT NOT NULL CHECK (phase IN ('admission', 'decision', 'outcome')),
  owner_id TEXT NOT NULL REFERENCES rika_hosted_owners(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL,
  turn_id TEXT NOT NULL CHECK (length(turn_id) > 0),
  actor JSONB NOT NULL CHECK (jsonb_typeof(actor) = 'object'),
  decision_actor JSONB CHECK (decision_actor IS NULL OR jsonb_typeof(decision_actor) = 'object'),
  policy_id TEXT NOT NULL CHECK (length(policy_id) > 0),
  policy_version INTEGER NOT NULL CHECK (policy_version > 0),
  capability TEXT NOT NULL CHECK (length(capability) > 0),
  capabilities JSONB NOT NULL CHECK (jsonb_typeof(capabilities) = 'array'),
  side_effect TEXT NOT NULL CHECK (side_effect IN (
    'none', 'workspace', 'terminal', 'git', 'secret', 'publishing', 'hosted-state', 'external'
  )),
  approval TEXT NOT NULL CHECK (approval IN ('none', 'exact')),
  replay_policy TEXT NOT NULL CHECK (replay_policy IN ('none', 'never', 'provider-idempotent')),
  authorization_id TEXT,
  authorization_checkpoint JSONB CHECK (
    authorization_checkpoint IS NULL
    OR (
      jsonb_typeof(authorization_checkpoint) = 'object'
      AND authorization_checkpoint ?& ARRAY['version', 'cursor', 'digest']
      AND authorization_checkpoint = jsonb_build_object(
        'version', authorization_checkpoint -> 'version',
        'cursor', authorization_checkpoint -> 'cursor',
        'digest', authorization_checkpoint -> 'digest'
      )
      AND authorization_checkpoint ->> 'digest' ~ '^[a-f0-9]{64}$'
    )
  ),
  module TEXT NOT NULL CHECK (length(module) > 0),
  operation TEXT NOT NULL CHECK (length(operation) > 0),
  operation_key TEXT NOT NULL CHECK (length(operation_key) > 0),
  call_id TEXT NOT NULL CHECK (length(call_id) > 0),
  arguments_digest TEXT NOT NULL CHECK (arguments_digest ~ '^[a-f0-9]{64}$'),
  workspace_id TEXT NOT NULL CHECK (length(workspace_id) > 0),
  repository JSONB CHECK (
    repository IS NULL
    OR (
      jsonb_typeof(repository) = 'object'
      AND repository ? 'identity'
      AND repository = jsonb_build_object('identity', repository -> 'identity')
    )
  ),
  branch TEXT,
  executor JSONB NOT NULL CHECK (
    jsonb_typeof(executor) = 'object'
    AND executor ?& ARRAY[
      'kind', 'assignmentId', 'generation', 'leaseEpoch', 'instanceId', 'executorId', 'processIncarnation'
    ]
    AND executor = jsonb_build_object(
      'kind', executor -> 'kind',
      'assignmentId', executor -> 'assignmentId',
      'generation', executor -> 'generation',
      'leaseEpoch', executor -> 'leaseEpoch',
      'instanceId', executor -> 'instanceId',
      'executorId', executor -> 'executorId',
      'processIncarnation', executor -> 'processIncarnation'
    )
  ),
  decision TEXT NOT NULL CHECK (decision IN ('not-required', 'pending', 'approved', 'denied')),
  outcome TEXT NOT NULL CHECK (outcome IN ('admitted', 'suspended', 'succeeded', 'failed', 'denied', 'unknown')),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  FOREIGN KEY (thread_id, owner_id, workspace_id)
    REFERENCES rika_hosted_threads(id, owner_id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, owner_id)
    REFERENCES rika_hosted_workspaces(id, owner_id) ON DELETE RESTRICT,
  CHECK (rika_hosted_actor_matches_owner(actor, owner_id)),
  CHECK (decision_actor IS NULL OR rika_hosted_actor_matches_owner(decision_actor, owner_id)),
  CHECK ((phase = 'decision') = (decision_actor IS NOT NULL)),
  CHECK ((decision IN ('approved', 'denied')) = (decision_actor IS NOT NULL)),
  CHECK (approval = 'exact' OR authorization_id IS NULL),
  CHECK (authorization_checkpoint IS NULL OR authorization_id IS NOT NULL)
);

CREATE INDEX rika_hosted_tool_audit_owner_timeline
  ON rika_hosted_tool_audit_records(owner_id, sequence DESC);

CREATE INDEX rika_hosted_tool_audit_thread_timeline
  ON rika_hosted_tool_audit_records(owner_id, thread_id, sequence DESC);

CREATE INDEX rika_hosted_tool_audit_authorization
  ON rika_hosted_tool_audit_records(owner_id, thread_id, turn_id, authorization_id, sequence DESC)
  WHERE authorization_id IS NOT NULL;

CREATE FUNCTION rika_hosted_reject_tool_audit_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' OR pg_trigger_depth() = 1 THEN
    RAISE EXCEPTION 'tool audit records are append-only' USING ERRCODE = '55000';
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER rika_hosted_tool_audit_append_only
  BEFORE UPDATE OR DELETE ON rika_hosted_tool_audit_records
  FOR EACH ROW EXECUTE FUNCTION rika_hosted_reject_tool_audit_mutation();
