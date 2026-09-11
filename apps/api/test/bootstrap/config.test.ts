import { describe, expect, it } from "@effect/vitest"
import { Effect, Inspectable, Redacted, Schema } from "effect"
import type { Environment } from "@rika/identity"
import {
  ApiV2ProductionConfigError,
  loadApiV2ProductionConfig,
  type ApiV2ProductionConfig,
} from "../../src/bootstrap/config"

const productionEnvironment = {
  NODE_ENV: "production",
  PORT: "3000",
  HOST: "0.0.0.0",
  BETTER_AUTH_URL: "https://api.example.com",
  BETTER_AUTH_SECRET: "abcdefghijklmnoPQRSTUVWXYZ0123456789",
  BETTER_AUTH_TRUSTED_ORIGINS: "https://console.example.com",
  DATABASE_URL: "postgresql://user:database-password@database.example.com:5432/rika",
  DATABASE_SSL: "verify-full",
  GITHUB_CLIENT_ID: "github-client",
  GITHUB_CLIENT_SECRET: "github-client-secret",
  RESEND_API_KEY: "resend-api-secret",
  EMAIL_FROM: "Rika <no-reply@example.com>",
  RIKA_RUNTIME_ENVIRONMENT: "production-blue",
  RIKA_API_REVISION: "deployment-42",
  RIKA_RUNTIME_STORAGE_BUCKET: "rika-runtime-production",
  RIKA_RUNTIME_STORAGE_REGION: "us-east-1",
  RIKA_RUNTIME_STORAGE_ENDPOINT: "https://objects.example.com",
  RIKA_RUNTIME_STORAGE_FORCE_PATH_STYLE: "false",
  AWS_ACCESS_KEY_ID: "runtime-access-key",
  AWS_SECRET_ACCESS_KEY: "runtime-secret-key",
  AWS_SESSION_TOKEN: "runtime-session-token",
  RIVET_ENDPOINT: "https://rivet.example.com",
  RIVET_NAMESPACE: "rika-production",
  RIVET_TOKEN: "rivet-secret-token",
} satisfies Environment

const configFailure = (environment: Environment): Effect.Effect<ApiV2ProductionConfigError, ApiV2ProductionConfig> =>
  loadApiV2ProductionConfig(environment).pipe(
    Effect.flip,
    Effect.map((error) => {
      expect(Schema.is(ApiV2ProductionConfigError)(error)).toBe(true)
      return error
    }),
  )

describe("ApiV2ProductionConfig", () => {
  it.effect("loads validated production configuration with every credential redacted", () =>
    Effect.gen(function* () {
      const config = yield* loadApiV2ProductionConfig(productionEnvironment)
      expect(config.environment).toBe("production-blue")
      expect(config.revision).toBe("deployment-42")
      expect(config.hostname).toBe("0.0.0.0")
      expect(config.port).toBe(3000)
      expect(config.runtimeStorage).toMatchObject({
        bucket: "rika-runtime-production",
        region: "us-east-1",
        endpoint: "https://objects.example.com",
        forcePathStyle: false,
      })
      expect(config.rivet).toMatchObject({
        endpoint: "https://rivet.example.com",
        namespace: "rika-production",
      })
      expect(Redacted.value(config.runtimeStorage.credentials!.accessKeyId)).toBe("runtime-access-key")
      expect(Redacted.value(config.runtimeStorage.credentials!.secretAccessKey)).toBe("runtime-secret-key")
      expect(Redacted.value(config.runtimeStorage.credentials!.sessionToken!)).toBe("runtime-session-token")
      expect(Redacted.value(config.rivet.token!)).toBe("rivet-secret-token")
      const inspected = Inspectable.toStringUnknown(config)
      for (const secret of [
        "database-password",
        "abcdefghijklmnoPQRSTUVWXYZ0123456789",
        "github-client-secret",
        "resend-api-secret",
        "runtime-access-key",
        "runtime-secret-key",
        "runtime-session-token",
        "rivet-secret-token",
      ])
        expect(inspected).not.toContain(secret)
    }),
  )

  it.effect("rejects incomplete storage credentials without echoing configured values", () =>
    Effect.gen(function* () {
      const omittedSecret = "access-value-that-must-stay-secret"
      const error = yield* configFailure({
        ...productionEnvironment,
        AWS_ACCESS_KEY_ID: omittedSecret,
        AWS_SECRET_ACCESS_KEY: undefined,
        AWS_SESSION_TOKEN: undefined,
      })
      expect(error).toMatchObject({ dependency: "runtime-storage" })
      expect(Inspectable.toStringUnknown(error)).not.toContain(omittedSecret)
    }),
  )

  it.effect("rejects credential-bearing and insecure production endpoints without exposing URL credentials", () =>
    Effect.gen(function* () {
      const embedded = "url-password-that-must-stay-secret"
      const credentialError = yield* configFailure({
        ...productionEnvironment,
        RIVET_ENDPOINT: `https://user:${embedded}@rivet.example.com`,
      })
      expect(credentialError).toMatchObject({ dependency: "rivet" })
      expect(Inspectable.toStringUnknown(credentialError)).not.toContain(embedded)
      const insecureError = yield* configFailure({
        ...productionEnvironment,
        RIKA_RUNTIME_STORAGE_ENDPOINT: "http://objects.example.com",
      })
      expect(insecureError).toMatchObject({ dependency: "runtime-storage" })
      expect(insecureError.message).toContain("HTTPS")
    }),
  )

  it.effect("permits plaintext endpoints only inside the Railway private mesh", () =>
    Effect.gen(function* () {
      const config = yield* loadApiV2ProductionConfig({
        ...productionEnvironment,
        RIVET_ENDPOINT: "http://rivet.railway.internal:6420",
      })
      expect(config.rivet.endpoint).toBe("http://rivet.railway.internal:6420")
      const publicHttp = yield* configFailure({
        ...productionEnvironment,
        RIVET_ENDPOINT: "http://rivet.example.com",
      })
      expect(publicHttp).toMatchObject({ dependency: "rivet" })
      const storagePrivate = yield* loadApiV2ProductionConfig({
        ...productionEnvironment,
        RIKA_RUNTIME_STORAGE_ENDPOINT: "http://minio.railway.internal:9000",
      })
      expect(storagePrivate.runtimeStorage.endpoint).toBe("http://minio.railway.internal:9000")
    }),
  )

  it.effect("requires stable runtime, revision, storage, and Rivet identities", () =>
    Effect.gen(function* () {
      for (const name of [
        "RIKA_RUNTIME_ENVIRONMENT",
        "RIKA_API_REVISION",
        "RIKA_RUNTIME_STORAGE_BUCKET",
        "RIKA_RUNTIME_STORAGE_REGION",
        "RIVET_ENDPOINT",
      ] as const) {
        const error = yield* configFailure({ ...productionEnvironment, [name]: undefined })
        expect(error.message).toContain(name)
      }
    }),
  )

  it.effect("rejects a host containing a port or URL path", () =>
    Effect.gen(function* () {
      const port = yield* configFailure({ ...productionEnvironment, HOST: "api.example.com:3000" })
      expect(port.message).toContain("HOST")
      const path = yield* configFailure({ ...productionEnvironment, HOST: "api.example.com/internal" })
      expect(path.message).toContain("HOST")
    }),
  )
})
