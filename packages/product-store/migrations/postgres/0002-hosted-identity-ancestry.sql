ALTER TABLE "member" ADD CONSTRAINT member_id_organization_unique UNIQUE (id, organization_id);

ALTER TABLE rika_hosted_projects
  ADD FOREIGN KEY (created_by_user_id) REFERENCES "user" (id) ON DELETE RESTRICT;
ALTER TABLE rika_hosted_project_grants
  ADD FOREIGN KEY (membership_id) REFERENCES "member" (id) ON DELETE CASCADE,
  ADD FOREIGN KEY (granted_by_user_id) REFERENCES "user" (id) ON DELETE RESTRICT;
ALTER TABLE rika_hosted_workspaces
  ADD FOREIGN KEY (created_by_user_id) REFERENCES "user" (id) ON DELETE RESTRICT;
ALTER TABLE rika_hosted_threads
  ADD FOREIGN KEY (created_by_user_id) REFERENCES "user" (id) ON DELETE RESTRICT;
ALTER TABLE rika_hosted_thread_grants
  ADD FOREIGN KEY (membership_id) REFERENCES "member" (id) ON DELETE CASCADE,
  ADD FOREIGN KEY (granted_by_user_id) REFERENCES "user" (id) ON DELETE RESTRICT;
ALTER TABLE rika_hosted_devices
  ADD FOREIGN KEY (user_id) REFERENCES "user" (id) ON DELETE CASCADE;
ALTER TABLE rika_hosted_clients
  ADD FOREIGN KEY (user_id) REFERENCES "user" (id) ON DELETE CASCADE;
ALTER TABLE rika_hosted_local_workspace_bindings
  ADD FOREIGN KEY (user_id) REFERENCES "user" (id) ON DELETE CASCADE;
ALTER TABLE rika_hosted_credential_references
  ADD FOREIGN KEY (created_by_user_id) REFERENCES "user" (id) ON DELETE RESTRICT;
