import * as ModelRouteResolution from "@rika/configuration/model-route-resolution"
import * as SettingsDefaults from "@rika/configuration/configuration-settings"
import * as SettingsDecoder from "@rika/configuration/configuration-settings"
import { describe, expect, it } from "@effect/vitest"
import { ModelRegistry } from "@batonfx/core"
import * as OpenAi from "@batonfx/providers/openai"
import { Config, Effect, Layer, Redacted, Schema } from "effect"
import { LanguageModel } from "effect/unstable/ai"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import * as ModelProviderRuntime from "../../../src/model/provider/model-provider-runtime"

const settingsWith = (baseUrl: string, promptCaching?: boolean): SettingsDefaults.ConfigurationSettings => ({
  ...SettingsDefaults.Defaults.defaults,
  providers: {
    ...SettingsDefaults.Defaults.defaults.providers,
    openai: {
      protocol: "openai",
      baseUrl,
      apiKeyEnv: "OPENAI_API_KEY",
      ...(promptCaching === undefined ? {} : { promptCaching }),
    },
  },
})

const proxyUrl = "https://switchboard-itt.up.railway.app/v1"

const nativeRoute = ModelRouteResolution.resolveModelRoute(SettingsDefaults.Defaults.defaults, "medium", "main")
const proxyRoute = ModelRouteResolution.resolveModelRoute(settingsWith(proxyUrl), "medium", "main")
const optedInProxyRoute = ModelRouteResolution.resolveModelRoute(settingsWith(proxyUrl, true), "medium", "main")

const Request = Schema.Struct({
  model: Schema.String,
  prompt_cache_retention: Schema.optionalKey(Schema.String),
  prompt_cache_key: Schema.optionalKey(Schema.String),
})

const decodeRequest = Schema.decodeSync(Schema.fromJsonString(Request))

const capturingProvider = (config: Readonly<Record<string, unknown>>, captured: Array<string>) =>
  OpenAi.layer({
    model: "gpt-5",
    registrationKey: "wire-probe",
    config: config as NonNullable<Parameters<typeof OpenAi.layer>[0]["config"]>,
    apiKey: Config.succeed(Redacted.make("test-key")),
    clientConfig: { apiUrl: Config.succeed(proxyUrl) },
  }).pipe(
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.sync(() => {
            const body = request.body
            if (body._tag === "Uint8Array") captured.push(new TextDecoder().decode(body.body))
            return HttpClientResponse.fromWeb(request, new Response("{}", { status: 500 }))
          }),
        ),
      ),
    ),
    Layer.orDie,
  )

const capturedRequestBody = (config: Readonly<Record<string, unknown>>) =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope
    const captured: Array<string> = []
    const provider = yield* Layer.buildWithScope(capturingProvider(config, captured), scope)
    const registrations = yield* ModelRegistry.registrations().pipe(Effect.provideContext(provider))
    const environment = yield* Layer.buildWithScope(registrations[0]!.layer, scope)
    yield* LanguageModel.LanguageModel.pipe(
      Effect.flatMap((model) => Effect.ignore(model.generateText({ prompt: "hello" }))),
      Effect.provideContext(environment),
    )
    return decodeRequest(captured[0]!)
  }).pipe(Effect.scoped)

describe("openai prompt cache retention", () => {
  it("asks for 24h retention on the native OpenAI endpoint so the prefix cache outlives the default window", () => {
    expect(ModelProviderRuntime.modelRoutePlan(nativeRoute).options).toMatchObject({ prompt_cache_retention: "24h" })
  })

  it("omits retention on an OpenAI-compatible endpoint that never promised the parameter", () => {
    expect(ModelProviderRuntime.modelRoutePlan(proxyRoute).options).not.toHaveProperty("prompt_cache_retention")
  })

  it("sends retention to the same proxy once promptCaching declares the endpoint supports it", () => {
    expect(ModelProviderRuntime.modelRoutePlan(optedInProxyRoute).options).toMatchObject({
      prompt_cache_retention: "24h",
    })
  })

  it("lets promptCaching false turn retention off even on the native endpoint", () => {
    const route = ModelRouteResolution.resolveModelRoute(
      settingsWith(SettingsDefaults.Defaults.defaults.providers.openai!.baseUrl!, false),
      "medium",
      "main",
    )
    expect(ModelProviderRuntime.modelRoutePlan(route).options).not.toHaveProperty("prompt_cache_retention")
  })

  it("accepts promptCaching as a provider key instead of rejecting it as unknown configuration", () => {
    const decoded = SettingsDecoder.Decoder.decodeSettingsInput("settings.json", {
      providers: { openai: { baseUrl: proxyUrl, promptCaching: true } },
    })
    expect(decoded.providers?.openai).toMatchObject({ promptCaching: true })
    expect(() =>
      SettingsDecoder.Decoder.decodeSettingsInput("settings.json", {
        providers: { openai: { baseUrl: proxyUrl, promptCaching: "yes" } },
      }),
    ).toThrow(/promptCaching must be a boolean/)
  })

  it("omits retention for the ChatGPT account adapter, which posts to the Codex backend", () => {
    expect(ModelProviderRuntime.modelRoutePlan(nativeRoute, "account-a").options).not.toHaveProperty(
      "prompt_cache_retention",
    )
  })

  it("keeps retention out of the Anthropic request options, where cache control does the work instead", () => {
    const route = ModelRouteResolution.resolveModelRoute(SettingsDefaults.Defaults.defaults, "medium", "main")
    const anthropic: ModelRouteResolution.ResolvedModelRoute = {
      ...route,
      providerId: "anthropic",
      providerConnection: {
        protocol: "anthropic",
        baseUrl: "https://api.anthropic.com",
        apiKeyEnv: "ANTHROPIC_API_KEY",
      },
    }
    expect(ModelProviderRuntime.modelRoutePlan(anthropic).options).not.toHaveProperty("prompt_cache_retention")
  })

  it.effect("reaches the Responses request body, because the provider spreads config straight into the payload", () =>
    Effect.gen(function* () {
      const body = yield* capturedRequestBody(ModelProviderRuntime.modelRoutePlan(optedInProxyRoute).options)
      expect(body.model).toBe("gpt-5")
      expect(body.prompt_cache_retention).toBe("24h")
      expect(body.prompt_cache_key).toBeUndefined()
    }),
  )

  it.effect("sends no retention key at all when the route did not ask for it", () =>
    Effect.gen(function* () {
      const body = yield* capturedRequestBody(ModelProviderRuntime.modelRoutePlan(proxyRoute).options)
      expect(body.model).toBe("gpt-5")
      expect(body.prompt_cache_retention).toBeUndefined()
    }),
  )

  it("changes the registration key so an opted-in endpoint never reuses its pre-retention registration", () => {
    expect(ModelProviderRuntime.modelRoutePlan(optedInProxyRoute).registrationKey).not.toBe(
      ModelProviderRuntime.modelRoutePlan(proxyRoute).registrationKey,
    )
    expect(ModelProviderRuntime.modelRoutePlan(nativeRoute).registrationKey).not.toBe(
      ModelProviderRuntime.modelRoutePlan(proxyRoute).registrationKey,
    )
  })
})
