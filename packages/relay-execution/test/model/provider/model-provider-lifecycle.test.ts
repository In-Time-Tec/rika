import * as ModelRouteResolution from "@rika/configuration/model-route-resolution"
import * as SettingsDefaults from "@rika/configuration/configuration-settings"
import { expect, test } from "vitest"
import * as OpenAiAuth from "@rika/product/openai-auth-service"
import * as OpenAiAuthContract from "@rika/product/openai-auth-contract"
import * as ExecutionRouteSnapshot from "@rika/product/execution-route-snapshot"
import { Cause, ConfigProvider, Context, Effect, Layer, Redacted, Schema, Scope } from "effect"
import { LanguageModel } from "effect/unstable/ai"
import { executionRoutePin, executionRoutePinFromPrepared, modelRoutesForExecution } from "./model-provider-fixture"
import { bedrockAuthRefreshTestLayer } from "../../../src/model/provider/model-provider-runtime"
import * as ModelProviderRuntime from "../../../src/model/provider/model-provider-runtime"
import { normalizePinnedRuntime } from "../../../src/model/provider/provider-adapters"

const credential = (fingerprint: string): OpenAiAuthContract.Credential => ({
  accessToken: Redacted.make("account-access-token"),
  idToken: Redacted.make("account-id-token"),
  refreshToken: Redacted.make("account-refresh-token"),
  accountId: Redacted.make("account-id"),
  fingerprint,
  generation: `${fingerprint}.generation`,
  expiresAt: Number.MAX_SAFE_INTEGER,
  refreshedAt: 1,
})

const authService = (
  status: OpenAiAuthContract.Status = { _tag: "Unauthenticated" },
  acquireFingerprint = status._tag === "Present" || status._tag === "RefreshRequired" ? status.fingerprint : "none",
): OpenAiAuth.ServiceInterface => ({
  loginBrowser: () => Effect.succeed(credential(acquireFingerprint)),
  loginDevice: Effect.succeed(credential(acquireFingerprint)),
  status: Effect.succeed(status),
  logout: Effect.succeed({ removed: true, revocationSupported: false }),
  acquire: Effect.succeed(credential(acquireFingerprint)),
  refreshRejected: () => Effect.succeed(credential(acquireFingerprint)),
})

const runtimeLayer = (auth: OpenAiAuth.ServiceInterface) =>
  ModelProviderRuntime.Service.layer.pipe(
    Layer.provide(Layer.succeed(OpenAiAuth.Service, auth)),
    Layer.provide(bedrockAuthRefreshTestLayer({ run: () => Effect.void })),
  )

type RuntimeInterface = Parameters<typeof ModelProviderRuntime.Service.of>[0]

const withRuntime = <A, E>(
  auth: OpenAiAuth.ServiceInterface,
  effect: (runtime: RuntimeInterface) => Effect.Effect<A, E, Scope.Scope>,
  environment: Readonly<Record<string, string>> = {},
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(runtimeLayer(auth))
      return yield* effect(Context.get(context, ModelProviderRuntime.Service))
    }),
  ).pipe(Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(environment)))

test("retains Anthropic registration behavior", () =>
  Effect.runPromise(
    withRuntime(
      authService(),
      (runtime) =>
        Effect.gen(function* () {
          const settings: SettingsDefaults.ConfigurationSettings = {
            ...SettingsDefaults.Defaults.defaults,
            modes: {
              ...SettingsDefaults.Defaults.defaults.modes,
              low: { ...SettingsDefaults.Defaults.defaults.modes.low, main: { alias: "fable", effort: "low" } },
            },
          }
          const route = ModelRouteResolution.resolveModelRoute(settings, "low", "main")
          const prepared = yield* runtime.prepare([route])
          expect(prepared.registrations[0]).toMatchObject({
            provider: "anthropic",
            model: "claude-fable-5",
            registrationKey: ModelProviderRuntime.modelRoutePlan(route).registrationKey,
          })
        }),
      { ANTHROPIC_API_KEY: "test" },
    ),
  ))

test("registers Bedrock routes and pins only non-secret connection identity", () =>
  Effect.runPromise(
    withRuntime(authService(), (runtime) =>
      Effect.gen(function* () {
        const refresh = { command: "aws", args: ["sso", "login", "--profile", "engineering"] }
        const settings: SettingsDefaults.ConfigurationSettings = {
          ...SettingsDefaults.Defaults.defaults,
          providers: {
            ...SettingsDefaults.Defaults.defaults.providers,
            bedrock: {
              protocol: "amazon-bedrock",
              region: "us-east-1",
              profile: "engineering",
              authMode: "default",
              authRefresh: refresh,
            },
          },
          models: {
            ...SettingsDefaults.Defaults.defaults.models,
            "bedrock-fable": {
              ...SettingsDefaults.Defaults.defaults.models.fable!,
              provider: "bedrock",
              candidates: ["us.anthropic.claude-sonnet-4-20250514-v1:0"],
            },
          },
          modes: {
            ...SettingsDefaults.Defaults.defaults.modes,
            low: { ...SettingsDefaults.Defaults.defaults.modes.low, main: { alias: "bedrock-fable", effort: "low" } },
          },
        }
        const route = ModelRouteResolution.resolveModelRoute(settings, "low", "main")
        const prepared = yield* runtime.prepare([route])
        expect(prepared.registrations[0]).toMatchObject({
          provider: "bedrock",
          model: "us.anthropic.claude-sonnet-4-20250514-v1:0",
        })
        expect(prepared.plans[0]?.runtime).toMatchObject({
          adapter: "amazon-bedrock",
          connectionIdentity: {
            authMode: "default",
            region: "us-east-1",
            profile: "engineering",
            authRefreshFingerprint: expect.stringMatching(/^sha256:/),
          },
        })
        const encoded = yield* Schema.encodeEffect(Schema.UnknownFromJsonString)(executionRoutePin(settings, "low"))
        expect(encoded).not.toContain(`"command":"${refresh.command}"`)
        expect(encoded).not.toContain('"args"')
      }),
    ),
  ))

test("keys Bedrock registrations by connection and refresh identity without ambient credentials", () => {
  const base = ModelRouteResolution.resolveModelRoute(
    {
      ...SettingsDefaults.Defaults.defaults,
      providers: {
        ...SettingsDefaults.Defaults.defaults.providers,
        bedrock: {
          protocol: "amazon-bedrock",
          region: "us-east-1",
          profile: "engineering",
          authMode: "default",
          authRefresh: { command: "aws", args: ["sso", "login", "--profile", "engineering"] },
        },
      },
      models: {
        ...SettingsDefaults.Defaults.defaults.models,
        "bedrock-fable": {
          ...SettingsDefaults.Defaults.defaults.models.fable!,
          provider: "bedrock",
          candidates: ["model"],
        },
      },
      modes: {
        ...SettingsDefaults.Defaults.defaults.modes,
        low: { ...SettingsDefaults.Defaults.defaults.modes.low, main: { alias: "bedrock-fable", effort: "low" } },
      },
    },
    "low",
  )
  const key = ModelProviderRuntime.modelRoutePlan(base).registrationKey
  for (const connection of [
    { ...base.providerConnection, region: "us-west-2" },
    { ...base.providerConnection, profile: "production" },
    { ...base.providerConnection, authMode: "bearer" as const },
    { ...base.providerConnection, authRefresh: { command: "aws", args: ["sso", "login"] } },
  ])
    expect(ModelProviderRuntime.modelRoutePlan({ ...base, providerConnection: connection }).registrationKey).not.toBe(
      key,
    )
  expect(ModelProviderRuntime.modelRoutePlan(base).registrationKey).toBe(key)
})

test("fails before registration when an API credential is missing without exposing a secret", () =>
  Effect.runPromise(
    withRuntime(authService(), (runtime) =>
      Effect.gen(function* () {
        const route = ModelRouteResolution.resolveModelRoute(SettingsDefaults.Defaults.defaults, "medium", "main")
        const exit = yield* Effect.exit(runtime.prepare([route]))
        expect(exit._tag).toBe("Failure")
        if (exit._tag === "Failure") {
          const text = Cause.pretty(exit.cause)
          expect(text).toContain("OPENAI_API_KEY")
          expect(text).toContain("openai")
          expect(text).not.toContain("account-access-token")
        }
      }),
    ),
  ))

test("uses a native OpenAI account without an API key and applies account request constraints", () =>
  Effect.runPromise(
    withRuntime(authService({ _tag: "Present", fingerprint: "account-a" }), (runtime) =>
      Effect.gen(function* () {
        const routes = modelRoutesForExecution(SettingsDefaults.Defaults.defaults, "medium")
        const prepared = yield* runtime.prepare(routes)
        expect(prepared.registrations.length).toBeGreaterThan(0)
        expect(prepared.plans[0]?.runtime).toEqual({ adapter: "openai-account", credentialIdentity: "account-a" })
        expect(prepared.plans[0]?.options).toMatchObject({ store: false })
        expect(prepared.plans[0]?.options).not.toHaveProperty("max_output_tokens")
        const execution = executionRoutePinFromPrepared("medium", prepared)
        expect(execution.main.providerConnection.authentication).toBe("account")
        expect(execution.main.providerConnection.apiKeyEnvironment).toBe("OPENAI_API_KEY")
      }),
    ),
  ))

test("pins provider runtime identity, roundtrips JSON, and normalizes old account pins", () => {
  const route = ModelRouteResolution.resolveModelRoute(SettingsDefaults.Defaults.defaults, "medium", "main")
  const api = ModelProviderRuntime.modelRoutePlan(route)
  const account = ModelProviderRuntime.modelRoutePlan(route, "account-a")
  expect(api.runtime).toEqual({ adapter: "openai", credentialIdentity: "OPENAI_API_KEY" })
  expect(account.runtime).toEqual({ adapter: "openai-account", credentialIdentity: "account-a" })
  expect(account.registrationKey).not.toBe(api.registrationKey)
  const pin = executionRoutePin(SettingsDefaults.Defaults.defaults, "medium")
  const encoded = Schema.decodeUnknownSync(ExecutionRouteSnapshot.ExecutionRoutePin)(JSON.parse(JSON.stringify(pin)))
  expect(encoded.main.providerConnection).toEqual(pin.main.providerConnection)
  expect(
    normalizePinnedRuntime({
      ...pin.main,
      provider: "openai",
      registrationKey: "old-registration",
      providerProtocol: "openai",
      providerBaseUrl: "https://api.openai.com/v1",
      openAiAccountFingerprint: "old-account",
    }),
  ).toEqual({ adapter: "openai-account", credentialIdentity: "old-account" })
})

test("custom OpenAI and Anthropic routes never evaluate corrupt account status", () =>
  Effect.runPromise(
    withRuntime(
      {
        ...authService(),
        status: Effect.fail(OpenAiAuthContract.StoreError.make({ kind: "corrupt", message: "hidden" })),
      },
      (runtime) =>
        Effect.gen(function* () {
          const settings: SettingsDefaults.ConfigurationSettings = {
            ...SettingsDefaults.Defaults.defaults,
            providers: {
              ...SettingsDefaults.Defaults.defaults.providers,
              openai: { protocol: "openai", baseUrl: "https://models.example.test/v1" },
            },
          }
          const routes = [
            ModelRouteResolution.resolveModelRoute(settings, "medium", "main"),
            ModelRouteResolution.resolveModelRoute(settings, "low", "main"),
          ]
          const prepared = yield* runtime.prepare(routes)
          expect(prepared.registrations).toHaveLength(2)
        }),
      { OPENAI_API_KEY: "test", ANTHROPIC_API_KEY: "test" },
    ),
  ))

test("observes a login between prepare calls without rebuilding the runtime", () => {
  let status: OpenAiAuthContract.Status = { _tag: "Unauthenticated" }
  const auth = { ...authService(), status: Effect.sync(() => status), acquire: Effect.succeed(credential("account-a")) }
  return Effect.runPromise(
    withRuntime(
      auth,
      (runtime) =>
        Effect.gen(function* () {
          const route = ModelRouteResolution.resolveModelRoute(SettingsDefaults.Defaults.defaults, "medium", "main")
          const first = yield* runtime.prepare([route])
          status = { _tag: "Present", fingerprint: "account-a" }
          const second = yield* runtime.prepare([route])
          expect(first.plans[0]?.runtime.adapter).toBe("openai")
          expect(second.plans[0]?.runtime.adapter).toBe("openai-account")
        }),
      { OPENAI_API_KEY: "test" },
    ),
  )
})

test("reuses one scoped registration across repeated prepare calls", () =>
  Effect.runPromise(
    withRuntime(
      authService(),
      (runtime) =>
        Effect.gen(function* () {
          const route = ModelRouteResolution.resolveModelRoute(SettingsDefaults.Defaults.defaults, "medium", "main")
          const first = yield* runtime.prepare([route])
          const second = yield* runtime.prepare([route])
          expect(second.registrations[0]).toBe(first.registrations[0])
        }),
      { OPENAI_API_KEY: "test" },
    ),
  ))

test("fails a mismatched account fingerprint before a request", () =>
  Effect.runPromise(
    withRuntime(authService({ _tag: "Present", fingerprint: "account-a" }, "account-b"), (runtime) =>
      Effect.gen(function* () {
        const prepared = yield* runtime.prepare([
          ModelRouteResolution.resolveModelRoute(SettingsDefaults.Defaults.defaults, "medium", "main"),
        ])
        const context = yield* Layer.build(prepared.registrations[0]!.layer)
        const exit = yield* Effect.exit(
          LanguageModel.generateText({ prompt: "must not send" }).pipe(Effect.provide(context)),
        )
        expect(exit._tag).toBe("Failure")
        if (exit._tag === "Failure") expect(Cause.pretty(exit.cause)).toContain("account credential acquire failed")
      }),
    ),
  ))

test("restores old API and account routes with their stored registration keys", () =>
  Effect.runPromise(
    withRuntime(
      authService({ _tag: "Present", fingerprint: "account-a" }),
      (runtime) =>
        Effect.gen(function* () {
          const base = executionRoutePin(SettingsDefaults.Defaults.defaults, "medium").main
          const oldBase = {
            ...base,
            provider: base.providerConnection.provider,
            providerProtocol: base.providerConnection.protocol,
            providerBaseUrl: base.providerConnection.baseUrl,
            ...(base.providerConnection.apiKeyEnvironment === undefined
              ? {}
              : { providerApiKeyEnv: base.providerConnection.apiKeyEnvironment }),
          }
          const api = {
            ...oldBase,
            registrationKey: "stored-api",
            providerRuntime: { adapter: "openai", credentialIdentity: "OPENAI_API_KEY" },
          }
          const account = {
            ...oldBase,
            providerRuntime: { adapter: "openai-account", credentialIdentity: "account-a" },
            registrationKey: "stored-account",
          }
          const restored = yield* runtime.restore([api, account])
          expect(restored.map((item) => item.registrationKey)).toEqual(["stored-api", "stored-account"])
        }),
      { OPENAI_API_KEY: "test" },
    ),
  ))
