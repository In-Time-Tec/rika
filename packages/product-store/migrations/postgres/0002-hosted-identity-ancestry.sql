ALTER TABLE "member" ADD CONSTRAINT member_id_organization_unique UNIQUE (id, organization_id);

ALTER TABLE rika_hosted_projects
  ADD CONSTRAINT rika_hosted_projects_creator_member_fk
  FOREIGN KEY (created_by_member_id, organization_id) REFERENCES "member" (id, organization_id) ON DELETE RESTRICT;
ALTER TABLE rika_hosted_project_grants
  ADD CONSTRAINT rika_hosted_project_grants_member_fk
  FOREIGN KEY (member_id, organization_id) REFERENCES "member" (id, organization_id) ON DELETE CASCADE,
  ADD CONSTRAINT rika_hosted_project_grants_grantor_fk
  FOREIGN KEY (granted_by_member_id, organization_id) REFERENCES "member" (id, organization_id) ON DELETE RESTRICT;
ALTER TABLE rika_hosted_workspaces
  ADD CONSTRAINT rika_hosted_workspaces_creator_member_fk
  FOREIGN KEY (created_by_member_id, organization_id) REFERENCES "member" (id, organization_id) ON DELETE RESTRICT;
ALTER TABLE rika_hosted_threads
  ADD CONSTRAINT rika_hosted_threads_creator_member_fk
  FOREIGN KEY (created_by_member_id, organization_id) REFERENCES "member" (id, organization_id) ON DELETE RESTRICT;
ALTER TABLE rika_hosted_thread_grants
  ADD CONSTRAINT rika_hosted_thread_grants_member_fk
  FOREIGN KEY (member_id, organization_id) REFERENCES "member" (id, organization_id) ON DELETE CASCADE,
  ADD CONSTRAINT rika_hosted_thread_grants_grantor_fk
  FOREIGN KEY (granted_by_member_id, organization_id) REFERENCES "member" (id, organization_id) ON DELETE RESTRICT;
ALTER TABLE rika_hosted_devices
  ADD CONSTRAINT rika_hosted_devices_member_fk
  FOREIGN KEY (member_id, organization_id) REFERENCES "member" (id, organization_id) ON DELETE CASCADE;
ALTER TABLE rika_hosted_credential_references
  ADD CONSTRAINT rika_hosted_credential_references_creator_member_fk
  FOREIGN KEY (created_by_member_id, organization_id) REFERENCES "member" (id, organization_id) ON DELETE RESTRICT;
