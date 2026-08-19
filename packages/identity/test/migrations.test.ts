import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { identityMigrations } from "../src/migrations"

describe("identity migrations", () => {
  it.effect("contains the reviewed Better Auth 1.7.1 PostgreSQL schema", () =>
    Effect.gen(function* () {
      expect(identityMigrations).toHaveLength(1)
      const migration = identityMigrations[0]
      expect(migration?.id).toBe("0001_better_auth_1_7_1")

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
})
