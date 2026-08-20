-- Better Auth 1.7.1 stores string-array fields as JSON in PostgreSQL.
-- Preserve existing values while aligning the reviewed schema with the live Kysely adapter.

ALTER TABLE "device_code" ALTER COLUMN "resources" TYPE jsonb USING CASE WHEN "resources" IS NULL THEN NULL ELSE to_jsonb("resources") END;
ALTER TABLE "oauth_access_token" ALTER COLUMN "resources" TYPE jsonb USING CASE WHEN "resources" IS NULL THEN NULL ELSE to_jsonb("resources") END;
ALTER TABLE "oauth_access_token" ALTER COLUMN "requested_user_info_claims" TYPE jsonb USING CASE WHEN "requested_user_info_claims" IS NULL THEN NULL ELSE to_jsonb("requested_user_info_claims") END;
ALTER TABLE "oauth_access_token" ALTER COLUMN "scopes" TYPE jsonb USING CASE WHEN "scopes" IS NULL THEN NULL ELSE to_jsonb("scopes") END;
ALTER TABLE "oauth_client" ALTER COLUMN "scopes" TYPE jsonb USING CASE WHEN "scopes" IS NULL THEN NULL ELSE to_jsonb("scopes") END;
ALTER TABLE "oauth_client" ALTER COLUMN "client_credentials_scopes" DROP DEFAULT;
ALTER TABLE "oauth_client" ALTER COLUMN "client_credentials_scopes" TYPE jsonb USING CASE WHEN "client_credentials_scopes" IS NULL THEN NULL ELSE to_jsonb("client_credentials_scopes") END;
ALTER TABLE "oauth_client" ALTER COLUMN "client_credentials_scopes" SET DEFAULT '[]'::jsonb;
ALTER TABLE "oauth_client" ALTER COLUMN "contacts" TYPE jsonb USING CASE WHEN "contacts" IS NULL THEN NULL ELSE to_jsonb("contacts") END;
ALTER TABLE "oauth_client" ALTER COLUMN "redirect_uris" TYPE jsonb USING CASE WHEN "redirect_uris" IS NULL THEN NULL ELSE to_jsonb("redirect_uris") END;
ALTER TABLE "oauth_client" ALTER COLUMN "post_logout_redirect_uris" TYPE jsonb USING CASE WHEN "post_logout_redirect_uris" IS NULL THEN NULL ELSE to_jsonb("post_logout_redirect_uris") END;
ALTER TABLE "oauth_client" ALTER COLUMN "grant_types" TYPE jsonb USING CASE WHEN "grant_types" IS NULL THEN NULL ELSE to_jsonb("grant_types") END;
ALTER TABLE "oauth_client" ALTER COLUMN "response_types" TYPE jsonb USING CASE WHEN "response_types" IS NULL THEN NULL ELSE to_jsonb("response_types") END;
ALTER TABLE "oauth_consent" ALTER COLUMN "resources" TYPE jsonb USING CASE WHEN "resources" IS NULL THEN NULL ELSE to_jsonb("resources") END;
ALTER TABLE "oauth_consent" ALTER COLUMN "requested_user_info_claims" TYPE jsonb USING CASE WHEN "requested_user_info_claims" IS NULL THEN NULL ELSE to_jsonb("requested_user_info_claims") END;
ALTER TABLE "oauth_consent" ALTER COLUMN "scopes" TYPE jsonb USING CASE WHEN "scopes" IS NULL THEN NULL ELSE to_jsonb("scopes") END;
ALTER TABLE "oauth_refresh_token" ALTER COLUMN "resources" TYPE jsonb USING CASE WHEN "resources" IS NULL THEN NULL ELSE to_jsonb("resources") END;
ALTER TABLE "oauth_refresh_token" ALTER COLUMN "requested_user_info_claims" TYPE jsonb USING CASE WHEN "requested_user_info_claims" IS NULL THEN NULL ELSE to_jsonb("requested_user_info_claims") END;
ALTER TABLE "oauth_refresh_token" ALTER COLUMN "scopes" TYPE jsonb USING CASE WHEN "scopes" IS NULL THEN NULL ELSE to_jsonb("scopes") END;
ALTER TABLE "oauth_resource" ALTER COLUMN "allowed_scopes" TYPE jsonb USING CASE WHEN "allowed_scopes" IS NULL THEN NULL ELSE to_jsonb("allowed_scopes") END;
