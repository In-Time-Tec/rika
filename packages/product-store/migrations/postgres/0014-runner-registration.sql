CREATE TABLE rika_hosted_runner_registrations (
  device_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  checkout_fingerprint TEXT NOT NULL CHECK (length(checkout_fingerprint) BETWEEN 1 AND 512),
  workspace_id TEXT NOT NULL,
  project_id TEXT,
  repository JSONB NOT NULL CHECK (jsonb_typeof(repository) = 'object'),
  kernel_profile JSONB NOT NULL CHECK (jsonb_typeof(kernel_profile) = 'object'),
  capabilities JSONB NOT NULL CHECK (jsonb_typeof(capabilities) = 'object'),
  remote_thread_creation_allowed BOOLEAN NOT NULL DEFAULT FALSE,
  registered_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (device_id, checkout_fingerprint),
  FOREIGN KEY (device_id, user_id) REFERENCES rika_hosted_devices (id, user_id) ON DELETE CASCADE
);

CREATE INDEX rika_hosted_runner_registration_user
  ON rika_hosted_runner_registrations (user_id, device_id, checkout_fingerprint);
