import { describe, expect, it } from "@effect/vitest"
import { Effect, Redacted, Schema } from "effect"
import { IdentityConfigError, loadIdentityConfig, type Environment } from "../src/config"

const productionEnvironment = {
  NODE_ENV: "production",
  PORT: "3000",
  BETTER_AUTH_URL: "https://control.example.com",
  BETTER_AUTH_SECRET: "abcdefghijklmnoPQRSTUVWXYZ0123456789",
  BETTER_AUTH_TRUSTED_ORIGINS: "https://control.example.com, https://console.example.com",
  DATABASE_URL: "postgresql://user:password@database.example.com:5432/rika",
  DATABASE_SSL: "verify-full",
  GITHUB_CLIENT_ID: "github-client",
  GITHUB_CLIENT_SECRET: "github-secret",
  RESEND_API_KEY: "resend-secret",
  EMAIL_FROM: "Rika <no-reply@example.com>",
} satisfies Environment

const configFailure = (environment: Environment) =>
  loadIdentityConfig(environment).pipe(
    Effect.flip,
    Effect.map((error) => {
      expect(Schema.is(IdentityConfigError)(error)).toBe(true)
      return error
    }),
  )

describe("IdentityConfig", () => {
  it.effect("loads a production identity configuration without exposing secrets", () =>
    Effect.gen(function* () {
      const config = yield* loadIdentityConfig(productionEnvironment)
      expect(config.production).toBe(true)
      expect(config.port).toBe(3000)
      expect(config.baseUrl).toBe("https://control.example.com")
      expect(config.resource).toBe("https://control.example.com/api/v1")
      expect(config.trustedOrigins).toEqual(["https://control.example.com", "https://console.example.com"])
      expect(Redacted.value(config.databaseUrl)).toBe(productionEnvironment.DATABASE_URL)
      expect(String(config.authSecret)).not.toContain(productionEnvironment.BETTER_AUTH_SECRET)
    }),
  )

  it.effect("rejects insecure production origins", () =>
    Effect.gen(function* () {
      const error = yield* configFailure({ ...productionEnvironment, BETTER_AUTH_URL: "http://control.example.com" })
      expect(error.message).toContain("https:")
    }),
  )

  it.effect("rejects a low-entropy authentication secret", () =>
    Effect.gen(function* () {
      const error = yield* configFailure({
        ...productionEnvironment,
        BETTER_AUTH_SECRET: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      })
      expect(error.message).toContain("at least 16 distinct characters")
    }),
  )

  it.effect("requires an explicit production database TLS policy", () =>
    Effect.gen(function* () {
      const { DATABASE_SSL: _, ...environment } = productionEnvironment
      const error = yield* configFailure(environment)
      expect(error.message).toContain("DATABASE_SSL")
    }),
  )

  it.effect("rejects control characters in the email sender", () =>
    Effect.gen(function* () {
      const error = yield* configFailure({
        ...productionEnvironment,
        EMAIL_FROM: "Rika\nBcc: recipient@example.com <no-reply@example.com>",
      })
      expect(error.message).toContain("EMAIL_FROM")
    }),
  )
})
