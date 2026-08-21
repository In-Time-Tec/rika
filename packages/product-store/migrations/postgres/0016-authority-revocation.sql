UPDATE rika_hosted_clients
SET expires_at = authenticated_at + interval '5 minutes'
WHERE expires_at > authenticated_at + interval '5 minutes';

ALTER TABLE rika_hosted_clients
  ADD CONSTRAINT rika_hosted_clients_short_lived
  CHECK (expires_at <= authenticated_at + interval '5 minutes');

CREATE TABLE rika_hosted_client_authorities (
  client_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  issued_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  PRIMARY KEY (client_id, owner_id),
  FOREIGN KEY (client_id) REFERENCES rika_hosted_clients (id) ON DELETE CASCADE,
  FOREIGN KEY (owner_id) REFERENCES rika_hosted_owners (id) ON DELETE CASCADE,
  CHECK (expires_at > issued_at),
  CHECK (expires_at <= issued_at + interval '5 minutes')
);

CREATE INDEX rika_hosted_client_authorities_active
  ON rika_hosted_client_authorities (owner_id, expires_at, client_id)
  WHERE revoked_at IS NULL;

ALTER TABLE rika_hosted_local_executor_admissions
  ADD COLUMN revoked_at TIMESTAMPTZ;

UPDATE rika_hosted_local_executor_admissions
SET expires_at = created_at + interval '5 minutes'
WHERE expires_at > created_at + interval '5 minutes';

ALTER TABLE rika_hosted_local_executor_admissions
  ADD CONSTRAINT rika_hosted_local_executor_admissions_short_lived
  CHECK (expires_at <= created_at + interval '5 minutes');

UPDATE rika_hosted_executor_assignments
SET bootstrap_expires_at = CASE
    WHEN bootstrap_expires_at > updated_at + interval '5 minutes' THEN updated_at + interval '5 minutes'
    ELSE bootstrap_expires_at
  END,
  lease_expires_at = CASE
    WHEN lease_expires_at > updated_at + interval '5 minutes' THEN updated_at + interval '5 minutes'
    ELSE lease_expires_at
  END
WHERE bootstrap_expires_at > updated_at + interval '5 minutes'
  OR lease_expires_at > updated_at + interval '5 minutes';

ALTER TABLE rika_hosted_executor_assignments
  ADD CONSTRAINT rika_hosted_executor_credentials_short_lived
  CHECK ((bootstrap_expires_at IS NULL OR bootstrap_expires_at <= updated_at + interval '5 minutes')
    AND (lease_expires_at IS NULL OR lease_expires_at <= updated_at + interval '5 minutes'));

CREATE FUNCTION rika_hosted_revoke_device_authority()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  authority_revoked_at TIMESTAMPTZ;
  authority_device_id TEXT;
  authority_user_id TEXT;
BEGIN
  IF TG_OP = 'UPDATE' AND (OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL) THEN
    RETURN NEW;
  END IF;

  authority_revoked_at := CASE WHEN TG_OP = 'DELETE' THEN transaction_timestamp() ELSE NEW.revoked_at END;
  authority_device_id := OLD.device_id::text;
  authority_user_id := OLD.user_id;

  UPDATE rika_hosted_devices
  SET revoked_at = COALESCE(revoked_at, authority_revoked_at)
  WHERE id = authority_device_id AND user_id = authority_user_id;

  UPDATE rika_hosted_clients
  SET revoked_at = COALESCE(revoked_at, authority_revoked_at)
  WHERE device_id = authority_device_id AND user_id = authority_user_id;

  UPDATE rika_hosted_client_authorities authority
  SET revoked_at = COALESCE(authority.revoked_at, authority_revoked_at)
  FROM rika_hosted_clients client_record
  WHERE authority.client_id = client_record.id
    AND client_record.device_id = authority_device_id
    AND client_record.user_id = authority_user_id;

  UPDATE rika_hosted_local_executor_admissions
  SET revoked_at = COALESCE(revoked_at, authority_revoked_at)
  WHERE device_id = authority_device_id AND user_id = authority_user_id;

  UPDATE rika_hosted_thread_socket_tickets
  SET revoked_at = COALESCE(revoked_at, authority_revoked_at)
  WHERE device_id = authority_device_id AND user_id = authority_user_id;

  DELETE FROM rika_hosted_local_runner_registrations
  WHERE device_id = authority_device_id AND user_id = authority_user_id;

  UPDATE rika_hosted_executor_assignments
  SET generation = generation + 1,
    revision = revision + 1,
    lifecycle = 'terminated',
    provider_instance_id = NULL,
    bootstrap_digest = NULL,
    bootstrap_expires_at = NULL,
    executor_instance_id = NULL,
    process_incarnation = NULL,
    session_digest = NULL,
    lease_epoch = NULL,
    lease_expires_at = NULL,
    updated_at = authority_revoked_at
  WHERE executor_kind = 'local_device'
    AND placement ->> 'deviceId' = authority_device_id
    AND lifecycle <> 'terminated';

  DELETE FROM rika_hosted_terminal_writer_leases
  WHERE actor ->> 'deviceId' = authority_device_id
    AND actor ->> 'userId' = authority_user_id;

  DELETE FROM rika_hosted_presence
  WHERE actor ->> 'deviceId' = authority_device_id
    AND actor ->> 'userId' = authority_user_id;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER rika_hosted_cli_device_revocation
AFTER UPDATE OF revoked_at ON rika_cli_registration
FOR EACH ROW EXECUTE FUNCTION rika_hosted_revoke_device_authority();

CREATE TRIGGER rika_hosted_cli_device_deletion
AFTER DELETE ON rika_cli_registration
FOR EACH ROW EXECUTE FUNCTION rika_hosted_revoke_device_authority();

CREATE FUNCTION rika_hosted_revoke_membership_authority()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  selected_owner_id TEXT;
BEGIN
  SELECT id INTO selected_owner_id
  FROM rika_hosted_owners
  WHERE kind = 'organization' AND organization_id = OLD.organization_id;

  IF selected_owner_id IS NULL THEN RETURN OLD; END IF;

  UPDATE rika_hosted_client_authorities authority
  SET revoked_at = COALESCE(authority.revoked_at, transaction_timestamp())
  FROM rika_hosted_clients client_record
  WHERE authority.client_id = client_record.id
    AND authority.owner_id = selected_owner_id
    AND client_record.user_id = OLD.user_id;

  UPDATE rika_hosted_local_executor_admissions admission
  SET revoked_at = COALESCE(admission.revoked_at, transaction_timestamp())
  WHERE admission.owner_id = selected_owner_id AND admission.user_id = OLD.user_id;

  UPDATE rika_hosted_executor_assignments assignment
  SET generation = assignment.generation + 1,
    revision = assignment.revision + 1,
    lifecycle = 'terminated',
    provider_instance_id = NULL,
    bootstrap_digest = NULL,
    bootstrap_expires_at = NULL,
    executor_instance_id = NULL,
    process_incarnation = NULL,
    session_digest = NULL,
    lease_epoch = NULL,
    lease_expires_at = NULL,
    updated_at = transaction_timestamp()
  FROM rika_hosted_devices device
  WHERE assignment.owner_id = selected_owner_id
    AND assignment.executor_kind = 'local_device'
    AND assignment.placement ->> 'deviceId' = device.id
    AND device.user_id = OLD.user_id
    AND assignment.lifecycle <> 'terminated';

  DELETE FROM rika_hosted_terminal_writer_leases
  WHERE owner_id = selected_owner_id AND actor ->> 'membershipId' = OLD.id;

  DELETE FROM rika_hosted_presence
  WHERE owner_id = selected_owner_id AND actor ->> 'membershipId' = OLD.id;

  RETURN OLD;
END;
$$;

CREATE TRIGGER rika_hosted_membership_revocation
AFTER DELETE ON member
FOR EACH ROW EXECUTE FUNCTION rika_hosted_revoke_membership_authority();

CREATE FUNCTION rika_hosted_revoke_project_grant_sessions()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM rika_hosted_terminal_writer_leases writer
  USING rika_hosted_threads thread
  WHERE writer.owner_id = OLD.owner_id
    AND writer.thread_id = thread.id
    AND thread.project_id = OLD.project_id
    AND writer.actor ->> 'membershipId' = OLD.membership_id;

  DELETE FROM rika_hosted_presence presence_record
  USING rika_hosted_threads thread
  WHERE presence_record.owner_id = OLD.owner_id
    AND presence_record.thread_id = thread.id
    AND thread.project_id = OLD.project_id
    AND presence_record.actor ->> 'membershipId' = OLD.membership_id;

  RETURN OLD;
END;
$$;

CREATE TRIGGER rika_hosted_project_grant_revocation
AFTER DELETE ON rika_hosted_project_grants
FOR EACH ROW EXECUTE FUNCTION rika_hosted_revoke_project_grant_sessions();

CREATE FUNCTION rika_hosted_revoke_thread_grant_sessions()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM rika_hosted_terminal_writer_leases
  WHERE owner_id = OLD.owner_id AND thread_id = OLD.thread_id
    AND actor ->> 'membershipId' = OLD.membership_id;

  DELETE FROM rika_hosted_presence
  WHERE owner_id = OLD.owner_id AND thread_id = OLD.thread_id
    AND actor ->> 'membershipId' = OLD.membership_id;

  RETURN OLD;
END;
$$;

CREATE TRIGGER rika_hosted_thread_grant_revocation
AFTER DELETE ON rika_hosted_thread_grants
FOR EACH ROW EXECUTE FUNCTION rika_hosted_revoke_thread_grant_sessions();
