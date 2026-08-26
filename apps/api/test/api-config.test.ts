import { describe, expect, it } from "@effect/vitest"
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
  GITHUB_APP_ID: "12345",
  GITHUB_APP_PRIVATE_KEY: "private-key",
  RESEND_API_KEY: "resend-secret",
  EMAIL_FROM: "Rika <no-reply@example.com>",
  E2B_API_KEY: "e2b-api-key",
  E2B_APP_ID: "rika",
  E2B_DEPLOYMENT_ID: "deployment-1",
  E2B_TEMPLATE_ID: "template",
  E2B_TEMPLATE_BUILD_ID: "build",
  RIKA_EXECUTOR_API_URL: "wss://api.example.com/api/v1/executors",
  RIKA_WORKSPACE_CHECKPOINT_BUCKET: "rika-checkpoints",
  RIKA_WORKSPACE_CHECKPOINT_REGION: "us-east-1",
  RIKA_WORKSPACE_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
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

describe("API configuration", () => {
  it.effect("reports missing production dependencies as typed startup errors", () =>
    Effect.gen(function* () {
      expect((yield* failure({ ...environment, DATABASE_URL: "" })).dependency).toBe("database")
      expect((yield* failure({ ...environment, E2B_API_KEY: "" })).dependency).toBe("executor-provider")
      expect((yield* failure({ ...environment, GITHUB_APP_PRIVATE_KEY: "" })).dependency).toBe("github-app")
      expect((yield* failure({ ...environment, RIKA_PROVIDER_CREDENTIAL_KEY: "invalid" })).dependency).toBe(
        "model-provider",
      )
    }),
  )

  it.effect("loads Runner-only development with the free OpenRouter route", () =>
    Effect.gen(function* () {
      const development = Object.fromEntries(
        Object.entries({ ...environment, NODE_ENV: "development", BETTER_AUTH_URL: "http://127.0.0.1:3000" }).filter(
          ([name]) =>
            !name.startsWith("E2B_") &&
            !name.startsWith("RIKA_EXECUTOR_") &&
            !name.startsWith("RIKA_WORKSPACE_") &&
            !name.startsWith("GITHUB_") &&
            name !== "RESEND_API_KEY" &&
            name !== "EMAIL_FROM",
        ),
      )
      const loaded = yield* loadApiConfig(development)
      expect(loaded.executor).toBeUndefined()
      expect(loaded.github).toBeUndefined()
      expect(loaded.developmentModel).toBe("openai/gpt-5-mini")
      expect(loaded.developmentSeedEnabled).toBe(false)
      expect((yield* loadApiConfig({ ...development, RIKA_DEV_SEED: "1" })).developmentSeedEnabled).toBe(true)
    }),
  )

  it.effect("rejects partial development E2B and GitHub App tuples", () =>
    Effect.gen(function* () {
      const development = {
        ...environment,
        NODE_ENV: "development",
        BETTER_AUTH_URL: "http://127.0.0.1:3000",
        GITHUB_CLIENT_ID: undefined,
        GITHUB_CLIENT_SECRET: undefined,
        RESEND_API_KEY: undefined,
        EMAIL_FROM: undefined,
      }
      expect((yield* failure({ ...development, E2B_API_KEY: undefined })).dependency).toBe("executor-provider")
      expect((yield* failure({ ...development, GITHUB_APP_PRIVATE_KEY: undefined })).dependency).toBe("github-app")
    }),
  )
})
