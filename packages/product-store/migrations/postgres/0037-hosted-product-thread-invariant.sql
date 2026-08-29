ALTER TABLE rika_threads
  ADD CONSTRAINT rika_threads_hosted_authority
  UNIQUE (id, owner_id, workspace);

ALTER TABLE rika_hosted_threads
  ADD CONSTRAINT rika_hosted_threads_product_state_fkey
  FOREIGN KEY (id, owner_id, workspace_id)
  REFERENCES rika_threads (id, owner_id, workspace)
  ON DELETE CASCADE
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE rika_threads
  ADD CONSTRAINT rika_threads_hosted_authority_fkey
  FOREIGN KEY (id, owner_id, workspace)
  REFERENCES rika_hosted_threads (id, owner_id, workspace_id)
  ON DELETE CASCADE
  DEFERRABLE INITIALLY DEFERRED;
