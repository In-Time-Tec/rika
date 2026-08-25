ALTER TABLE rika_hosted_runner_registrations
  ADD COLUMN supervisor_id UUID,
  ADD COLUMN supervisor_expires_at TIMESTAMPTZ,
  ADD CONSTRAINT rika_hosted_runner_supervisor_pair
    CHECK ((supervisor_id IS NULL) = (supervisor_expires_at IS NULL));
