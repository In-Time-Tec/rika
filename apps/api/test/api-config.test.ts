import { expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { ApiConfigError, loadApiConfig } from "../src/api-config"

const environment = {
  NODE_ENV: "production",
  PORT: "3000",
  BETTER_AUTH_URL: "https://api.example.com",
  BETTER_AUTH_SECRET: "abcdefghijklmnoPQRSTUVWXYZ0123456789",
  BETTER_AUTH_TRUSTED_ORIGINS: "https://api.example.com",
  DATABASE_URL: "postgresql://user:password@database.example.com:5432/rika",
  DATABASE_SSL: "verify-full",
  GITHUB_CLIENT_ID: "github-client",
  GITHUB_CLIENT_SECRET: "github-secret",
  RESEND_API_KEY: "resend-secret",
  EMAIL_FROM: "Rika <no-reply@example.com>",
  E2B_API_KEY: "e2b-api-key",
  E2B_APP_ID: "rika",
  E2B_DEPLOYMENT_ID: "deployment-1",
  E2B_TEMPLATE_ID: "template",
  E2B_TEMPLATE_BUILD_ID: "build",
  RIKA_EXECUTOR_API_URL: "wss://api.example.com/api/v1/executors",
  RIKA_PROVIDER_CREDENTIAL_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
}

const failure = (input: Record<string, string | undefined>) =>
  loadApiConfig(input).pipe(
    Effect.flip,
    Effect.map((error) => {
      expect(Schema.is(ApiConfigError)(error)).toBe(true)
      return error
    }),
  )

it.effect("reports missing database and executor provider configuration as typed startup errors", () =>
  Effect.gen(function* () {
    expect((yield* failure({ ...environment, DATABASE_URL: "" })).dependency).toBe("database")
    expect((yield* failure({ ...environment, E2B_API_KEY: "" })).dependency).toBe("executor-provider")
    expect((yield* failure({ ...environment, RIKA_PROVIDER_CREDENTIAL_KEY: "invalid" })).dependency).toBe(
      "model-provider",
    )
  }),
)
