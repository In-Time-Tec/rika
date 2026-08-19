CREATE TABLE rika_cli_registration (
  client_id TEXT PRIMARY KEY REFERENCES oauth_client (client_id) ON DELETE CASCADE,
  device_id UUID NOT NULL UNIQUE,
  public_jwk JSONB NOT NULL CHECK (
    jsonb_typeof(public_jwk) = 'object'
    AND public_jwk ->> 'kty' = 'EC'
    AND public_jwk ->> 'crv' = 'P-256'
    AND public_jwk ? 'x'
    AND public_jwk ? 'y'
    AND NOT public_jwk ? 'd'
  ),
  jwk_thumbprint TEXT NOT NULL UNIQUE CHECK (length(jwk_thumbprint) > 0),
  user_id TEXT REFERENCES "user" (id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  last_seen_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);

CREATE INDEX rika_cli_registration_user
  ON rika_cli_registration (user_id, revoked_at, last_seen_at DESC);
