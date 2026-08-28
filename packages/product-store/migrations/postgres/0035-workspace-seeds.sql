ALTER TABLE rika_hosted_executor_assignments
  ADD COLUMN workspace_seed jsonb;

ALTER TABLE rika_hosted_executor_assignments
  ADD CONSTRAINT rika_hosted_executor_assignments_workspace_seed_check
  CHECK (
    workspace_seed IS NULL OR (
      executor_kind = 'orb'::rika_hosted_executor_kind AND
      jsonb_typeof(workspace_seed) = 'object'::text AND
      workspace_seed ?& ARRAY[
        'id'::text,
        'sourceRepository'::text,
        'objectKey'::text,
        'contentDigest'::text,
        'sizeBytes'::text,
        'archiveDigest'::text,
        'archiveSizeBytes'::text,
        'encryption'::text
      ]
    )
  );

CREATE TABLE rika_hosted_workspace_seeds (
  id text PRIMARY KEY,
  created_by_user_id text NOT NULL,
  created_by_device_id text NOT NULL,
  created_by_client_id text NOT NULL,
  manifest jsonb NOT NULL,
  claimed_assignment_id text REFERENCES rika_hosted_executor_assignments(id) ON DELETE CASCADE,
  expires_at timestamp with time zone NOT NULL,
  created_at timestamp with time zone DEFAULT transaction_timestamp() NOT NULL,
  CONSTRAINT rika_hosted_workspace_seeds_claimed_assignment_id_key UNIQUE (claimed_assignment_id),
  CONSTRAINT rika_hosted_workspace_seeds_expiry_check CHECK (expires_at > created_at),
  CONSTRAINT rika_hosted_workspace_seeds_manifest_check CHECK (
    jsonb_typeof(manifest) = 'object'::text AND manifest ->> 'id'::text = id
  )
);

CREATE INDEX rika_hosted_workspace_seeds_expiry
  ON rika_hosted_workspace_seeds USING btree (expires_at);
