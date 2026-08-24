CREATE UNIQUE INDEX rika_hosted_credential_references_openai_account_idx
  ON rika_hosted_credential_references (owner_id, provider)
  WHERE purpose = 'model-provider-account';

CREATE TABLE rika_hosted_openai_account_credentials (
  credential_reference_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES rika_hosted_owners(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'openai' CHECK (provider = 'openai'),
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  revision BIGINT NOT NULL CHECK (revision > 0),
  fingerprint TEXT NOT NULL CHECK (length(fingerprint) > 0),
  key_version INTEGER,
  nonce BYTEA,
  ciphertext BYTEA,
  authentication_tag BYTEA,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  rotated_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  UNIQUE (owner_id),
  FOREIGN KEY (credential_reference_id, owner_id, provider)
    REFERENCES rika_hosted_credential_references(id, owner_id, provider)
    ON DELETE CASCADE,
  CHECK (
    (status = 'active'
      AND key_version IS NOT NULL
      AND octet_length(nonce) = 12
      AND octet_length(ciphertext) > 0
      AND octet_length(authentication_tag) = 16
      AND revoked_at IS NULL)
    OR
    (status = 'revoked'
      AND key_version IS NULL
      AND nonce IS NULL
      AND ciphertext IS NULL
      AND authentication_tag IS NULL
      AND revoked_at IS NOT NULL)
  )
);

CREATE INDEX rika_hosted_openai_account_credentials_active_idx
  ON rika_hosted_openai_account_credentials (owner_id)
  WHERE status = 'active';
