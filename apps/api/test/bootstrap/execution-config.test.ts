import { describe, expect, it } from "@effect/vitest"
import type { Environment } from "@rika/identity"
import { Effect, Inspectable, Redacted } from "effect"
import { loadExecutionConfig } from "../../src/bootstrap/execution-config"
import { executionEnvironment } from "./execution.harness"

describe("production execution configuration", () => {
  it.effect("loads pinned placement and model settings without exposing credentials", () =>
    Effect.gen(function* () {
      const config = yield* loadExecutionConfig(executionEnvironment, true)
      expect(config.model).toEqual({
        selection: { provider: "openai", model: "gpt-6-astra" },
        settings: { maxOutputTokens: 4096, reasoningEffort: "max" },
      })
      expect(config.box.policy).toEqual({
        template: { sourceBoxId: "bx_23456789", snapshotId: "00000000-0000-4000-8000-000000000000" },
        ttlSeconds: 3600,
        readinessAttempts: 60,
        readinessDelayMillis: 1000,
      })
      expect(config.github.appId).toBe(1234)
      expect(config.box.baseUrl).toBe("https://box.example.com/api")
      expect(Redacted.value(config.box.apiKey)).toBe(executionEnvironment.BOX_API_KEY)
      const inspected = Inspectable.toStringUnknown(config)
      for (const secret of [
        executionEnvironment.RIKA_PROVIDER_CREDENTIAL_KEY,
        executionEnvironment.GITHUB_APP_PRIVATE_KEY,
        executionEnvironment.BOX_API_KEY,
      ])
        expect(inspected).not.toContain(secret)
    }),
  )

  it.effect("rejects missing credentials, invalid model settings, and mutable or unbounded Box configuration", () =>
    Effect.gen(function* () {
      for (const patch of [
        { RIKA_PROVIDER_CREDENTIAL_KEY: undefined },
        { RIKA_WORKSPACE_INPUT_KEY: undefined },
        { GITHUB_APP_PRIVATE_KEY: undefined },
        { GITHUB_APP_ID: "1.5" },
        { BOX_API_KEY: undefined },
        { RIKA_MODEL_PROVIDER: "unsupported" },
        { RIKA_MODEL_ID: "" },
        { RIKA_MODEL_MAX_OUTPUT_TOKENS: "-1" },
        { RIKA_MODEL_REASONING_EFFORT: "" },
        { RIKA_BOX_TEMPLATE_BOX_ID: "latest" },
        { RIKA_BOX_TEMPLATE_SNAPSHOT_ID: "latest" },
        { RIKA_BOX_TTL_SECONDS: "86401" },
        { RIKA_BOX_PROVIDER_SCOPE: "" },
      ] satisfies ReadonlyArray<Environment>) {
        const error = yield* loadExecutionConfig({ ...executionEnvironment, ...patch }, true).pipe(Effect.flip)
        expect(error._tag).toBe("RikaExecutionConfigError")
        expect(Inspectable.toStringUnknown(error)).not.toContain(executionEnvironment.BOX_API_KEY)
      }
    }),
  )

  it.effect("allows loopback HTTP only in development and never echoes credential-bearing URLs", () =>
    Effect.gen(function* () {
      const local = { ...executionEnvironment, BOX_API_URL: "http://127.0.0.1:3456/api" }
      expect((yield* loadExecutionConfig(local, false)).box.baseUrl).toBe(local.BOX_API_URL)
      for (const url of [
        local.BOX_API_URL,
        "https://user:hidden-url-credential@box.example.com/api",
        "https://box.example.com/api?token=hidden-url-credential",
        "https://box.example.com/api#hidden-url-credential",
      ]) {
        const error = yield* loadExecutionConfig({ ...executionEnvironment, BOX_API_URL: url }, true).pipe(Effect.flip)
        expect(error.dependency).toBe("box")
        expect(Inspectable.toStringUnknown(error)).not.toContain("hidden-url-credential")
      }
    }),
  )
})
