import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { identityMigrations } from "../src/migrations"

describe("identity migrations", () => {
  it.effect("contains the reviewed Better Auth 1.7.1 PostgreSQL schema", () =>
    Effect.gen(function* () {
      expect(identityMigrations).toHaveLength(3)
      const migration = identityMigrations[0]
      expect(migration?.id).toBe("identity/0001_better_auth_1_7_1")
      expect(migration?.checksum).toBe("c07ac178826ea802f00c94f35fbc9b1fad12bbf5efa9a53500f4dc203446df38")

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
      expect(migration?.checksum).toBe("594c5e7c4bfe49c06ecf0305993e4b53886363ff3619a3da61bf43df9fdeccef")

      const sql = yield* Effect.promise(() => Bun.file(migration?.url ?? "").text())
      expect(sql).toContain("CREATE TABLE rika_cli_registration")
      expect(sql).toContain("REFERENCES oauth_client (client_id) ON DELETE CASCADE")
      expect(sql).toContain("public_jwk JSONB NOT NULL")
      expect(sql).toContain("jwk_thumbprint TEXT NOT NULL UNIQUE")
      expect(sql).toContain("revoked_at TIMESTAMPTZ")
    }),
  )

  it.effect("aligns Better Auth string arrays with the PostgreSQL adapter", () =>
    Effect.gen(function* () {
      const migration = identityMigrations[2]
      expect(migration?.id).toBe("identity/0003_better_auth_postgres_contract")
      expect(migration?.checksum).toBe("b4a8657e50c0fae5bb58c3be0617853a308130f095d8a7e2f587282bacc592bb")

      const sql = yield* Effect.promise(() => Bun.file(migration?.url ?? "").text())
      expect(sql.match(/TYPE jsonb/g)).toHaveLength(18)
      expect(sql).toContain(`ALTER COLUMN "client_credentials_scopes" SET DEFAULT '[]'::jsonb`)
    }),
  )
})
