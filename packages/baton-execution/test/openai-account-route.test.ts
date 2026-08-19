import { expect, it } from "@effect/vitest"
import { ModelRegistry } from "tenetkit"
import * as Settings from "@rika/configuration/configuration-settings"
import * as ExecutionRouteResolution from "@rika/product/execution-route-resolution"
import type * as OpenAiAuth from "@rika/product/openai-auth-service"
import { ConfigProvider, Context, Effect, Exit, Layer, Redacted, Schema } from "effect"
import { Chat, LanguageModel } from "effect/unstable/ai"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import * as CandidateRegistry from "../src/baton-candidate-registry"
import { configure } from "./baton-test-adapters"

const kernel = { runtimeVersion: "1.3.14", dataRoot: "/data" } as const

const credential = {
  accessToken: Redacted.make("oauth-access-token"),
  idToken: Redacted.make("oauth-id-token"),
  refreshToken: Redacted.make("oauth-refresh-token"),
  accountId: Redacted.make("chatgpt-account-id"),
  fingerprint: "account-fingerprint-one",
  generation: "account-fingerprint-one.generation",
  expiresAt: Number.MAX_SAFE_INTEGER,
  refreshedAt: 0,
}

const auth = {
  loginBrowser: () => Effect.succeed(credential),
  loginDevice: Effect.succeed(credential),
  status: Effect.succeed({ _tag: "Present" as const, fingerprint: credential.fingerprint }),
  logout: Effect.succeed({ removed: true, revocationSupported: false as const }),
  acquire: Effect.succeed(credential),
  refreshRejected: () => Effect.succeed(credential),
} satisfies OpenAiAuth.ServiceInterface

const accountRoute = () =>
  ExecutionRouteResolution.resolve(Settings.Defaults.settingsDefaults, "medium", undefined, {
    openAiAccountFingerprint: credential.fingerprint,
  })

const encodeRegistrations = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

it("pins native OpenAI account authentication and account-compatible request options", () => {
  const apiKey = ExecutionRouteResolution.resolve(Settings.Defaults.settingsDefaults, "medium")
  const account = accountRoute()
  expect(account.main.candidates[0]?.providerConnection).toEqual({
    provider: "openai",
    protocol: "openai",
    baseUrl: "https://api.openai.com/v1",
    authentication: "account",
    credentialIdentity: credential.fingerprint,
  })
  expect(account.main.candidates[0]?.providerOptions).toMatchObject({ store: false })
  expect(account.main.candidates[0]?.providerOptions).not.toHaveProperty("max_output_tokens")
  expect(account.main.registrationIdentity).not.toBe(apiKey.main.registrationIdentity)
  expect(account.main.candidates[0]?.registrationIdentity).not.toBe(apiKey.main.candidates[0]?.registrationIdentity)

  const secondAccount = ExecutionRouteResolution.resolve(Settings.Defaults.settingsDefaults, "medium", undefined, {
    openAiAccountFingerprint: "account-fingerprint-two",
  })
  expect(secondAccount.main.registrationIdentity).not.toBe(account.main.registrationIdentity)

  const customSettings: Settings.ConfigurationSettings = {
    ...Settings.Defaults.settingsDefaults,
    providers: {
      ...Settings.Defaults.settingsDefaults.providers,
      openai: {
        protocol: "openai" as const,
        baseUrl: "https://openai-compatible.example/v1",
        apiKeyEnv: "OPENAI_API_KEY",
      },
    },
  }
  const custom = ExecutionRouteResolution.resolve(customSettings, "medium", undefined, {
    openAiAccountFingerprint: credential.fingerprint,
  })
  expect(custom.main.candidates[0]?.providerConnection).toMatchObject({
    baseUrl: "https://openai-compatible.example/v1",
    authentication: "api-key",
    apiKeyEnvironment: "OPENAI_API_KEY",
  })
})

it.effect("fails recovered account routes through the typed registration channel when host authority is absent", () =>
  Effect.gen(function* () {
    const failed = yield* configure({ executionRoute: accountRoute(), workspace: "/workspace", kernel }).pipe(
      Effect.exit,
    )
    expect(Exit.isFailure(failed)).toBe(true)
    if (Exit.isFailure(failed))
      expect(failed.cause.reasons.find((reason) => reason._tag === "Fail")).toMatchObject({
        error: {
          _tag: "tenetkit/runtime/ExecutableRegistrationInvalid",
          message: expect.stringContaining("authentication is unavailable"),
        },
      })
  }),
)

it.effect("executes a valid account route through the Codex endpoint without an API key", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const route = accountRoute()
      const candidate = route.main.candidates[0]!
      const requests: Array<{ readonly url: string; readonly headers: Readonly<Record<string, string>> }> = []
      const httpClientLayer = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          requests.push({ url: request.url, headers: request.headers })
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response("{}", { status: 500, headers: { "content-type": "application/json" } }),
            ),
          )
        }),
      )
      const context = yield* Layer.build(
        CandidateRegistry.layer({ candidate, openAiAccountAuth: auth, httpClientLayer }),
      )
      const model = yield* ModelRegistry.operate(
        {
          provider: candidate.providerConnection.provider,
          model: candidate.model,
          registrationKey: candidate.registrationIdentity,
        },
        Effect.service(LanguageModel.LanguageModel),
      ).pipe(Effect.provideService(ModelRegistry.ModelRegistry, Context.get(context, ModelRegistry.ModelRegistry)))
      const chat = yield* Chat.fromPrompt([])
      yield* chat
        .generateText({ prompt: "hello" })
        .pipe(Effect.provideService(LanguageModel.LanguageModel, model), Effect.exit)
      expect(requests).toHaveLength(1)
      expect(requests[0]?.url).toBe("https://chatgpt.com/backend-api/codex/responses")
      expect(requests[0]?.headers.authorization).toBe("Bearer oauth-access-token")
      expect(requests[0]?.headers["chatgpt-account-id"]).toBe("chatgpt-account-id")

      const configured = yield* configure({
        executionRoute: route,
        workspace: "/workspace",
        kernel,
        openAiAccountAuth: auth,
      }).pipe(Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env: {} })))
      const encoded = encodeRegistrations(configured.registrations)
      for (const secret of ["oauth-access-token", "oauth-id-token", "oauth-refresh-token", "chatgpt-account-id"])
        expect(encoded).not.toContain(secret)
    }),
  ),
)
