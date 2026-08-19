import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { identityMigrations } from "../src/migrations"

describe("identity migrations", () => {
  it.effect("contains the reviewed Better Auth 1.7.1 PostgreSQL schema", () =>
    Effect.gen(function* () {
      expect(identityMigrations).toHaveLength(2)
      const migration = identityMigrations[0]
      expect(migration?.id).toBe("identity/0001_better_auth_1_7_1")

      const sql = yield* Effect.promise(() => Bun.file(migration?.url ?? "").text())
      const tables = [...sql.matchAll(/CREATE TABLE "([^"]+)"/g)].map((match) => match[1]).sort()
      expect(tables).toEqual(
        [
          "account",
          "device_code",
          "invitation",
          "jwks",
          "member",
          "oauth_access_token",
          "oauth_client",
          "oauth_client_assertion",
          "oauth_client_resource",
          "oauth_consent",
          "oauth_refresh_token",
          "oauth_resource",
          "organization",
          "session",
          "user",
          "verification",
        ].sort(),
      )
      expect(sql).toContain('"dpop_bound_access_tokens" boolean')
      expect(sql).toContain('"confirmation" jsonb')
      expect(sql).toContain('"resources" text[]')
    }),
  )

  it.effect("contains the CLI device registration schema", () =>
    Effect.gen(function* () {
      const migration = identityMigrations[1]
      expect(migration?.id).toBe("identity/0002_cli_devices")

      const sql = yield* Effect.promise(() => Bun.file(migration?.url ?? "").text())
      expect(sql).toContain("CREATE TABLE rika_cli_registration")
      expect(sql).toContain("REFERENCES oauth_client (client_id) ON DELETE CASCADE")
      expect(sql).toContain("public_jwk JSONB NOT NULL")
      expect(sql).toContain("jwk_thumbprint TEXT NOT NULL UNIQUE")
      expect(sql).toContain("revoked_at TIMESTAMPTZ")
    }),
  )
})
