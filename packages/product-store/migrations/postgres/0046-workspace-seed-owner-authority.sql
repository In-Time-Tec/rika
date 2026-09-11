ALTER TABLE rika_hosted_workspace_seeds
  ADD COLUMN owner_id text;

ALTER TABLE rika_hosted_workspace_seeds
  ADD CONSTRAINT rika_hosted_workspace_seeds_owner_id_fkey
  FOREIGN KEY (owner_id) REFERENCES rika_hosted_owners (id) ON DELETE CASCADE;
