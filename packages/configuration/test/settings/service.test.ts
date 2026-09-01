import "./service.harness"
import "./service-scenarios.fixture"
import { describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Context, Effect, Function, Layer, Redacted, Schema } from "effect"
import * as SettingsDefaults from "../../src/settings/defaults"
import * as ModelResolution from "../../src/model-routing/model-route-resolution"
import * as ConfigurationService from "../../src/settings/service"

const ConfigContract = { ...SettingsDefaults, ...ModelResolution }

const webProviders = [
  { id: "parallel", credentialEnvironment: "PARALLEL_API_KEY" },
  { id: "exa", credentialEnvironment: "EXA_API_KEY" },
  { id: "firecrawl", credentialEnvironment: "FIRECRAWL_API_KEY" },
  { id: "github", credentialEnvironment: "GITHUB_TOKEN" },
] as const

const provideLayer: {
  <RIn, E2, ROut>(
    layer: Layer.Layer<ROut, E2, RIn>,
  ): <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E | E2, RIn | Exclude<R, ROut>>
  <A, E, R, RIn, E2, ROut>(
    effect: Effect.Effect<A, E, R>,
    layer: Layer.Layer<ROut, E2, RIn>,
  ): Effect.Effect<A, E | E2, RIn | Exclude<R, ROut>>
} = Function.dual(2, <A, E, R, RIn, E2, ROut>(effect: Effect.Effect<A, E, R>, layer: Layer.Layer<ROut, E2, RIn>) =>
  Effect.scoped(Effect.flatMap(Layer.build(layer), (context) => Effect.provide(effect, context))),
)

describe("ConfigService", () => {
  it.effect("uses built-in providers and internal model policy when settings omit providers", () =>
    Effect.gen(function* () {
      const config = yield* ConfigurationService.effectiveConfiguration()
      expect(config.settings.providers).toEqual(ConfigContract.defaults.providers)
      expect(config.settings.models).toBe(ConfigContract.defaults.models)
      expect(config.settings.modes).toBe(ConfigContract.defaults.modes)
      expect(config.settings.compaction).toEqual(ConfigContract.defaults.compaction)
      expect(config.settings.subagents).toEqual({ maxDepth: 1, maxSubagents: 4 })
      expect(config.environment.providerCredentials).toEqual({})
      expect(config.environment.webSearchCredentials).toEqual({})
    }).pipe(provideLayer(ConfigurationService.memoryConfigurationLayer())),
  )

  it.effect("replaces a global provider override at workspace scope without inheriting its credential", () =>
    Effect.gen(function* () {
      const config = yield* ConfigurationService.effectiveConfiguration()
      expect(config.settings.providers.openai).toEqual({
        protocol: "openai-responses",
        baseUrl: "https://workspace.models.test/v1",
      })
      expect(config.settings.providers.anthropic).toEqual(ConfigContract.defaults.providers.anthropic)
      const routes = [
        ConfigContract.resolveModelRoute(config.settings, "low", "main"),
        ConfigContract.resolveModelRoute(config.settings, "medium", "main"),
        ConfigContract.resolveModelRoute(config.settings, "high", "main"),
        ConfigContract.resolveModelRoute(config.settings, "ultra", "oracle"),
        ConfigContract.resolveThreadTitleRoute(config.settings),
        ConfigContract.resolveCompactionSummaryRoute(config.settings),
      ]
      expect(routes.every((route) => route.providerConnection === config.settings.providers.openai)).toBe(true)
      expect(routes.map((route) => route.providerConnection.baseUrl)).toEqual(
        Array.from({ length: routes.length }, () => "https://workspace.models.test/v1"),
      )
      expect(
        routes.every(
          (route) =>
            route.compaction.contextWindow === 272_000 &&
            route.compaction.reserveTokens === 13_600 &&
            route.compaction.keepRecentTokens === 32_000,
        ),
      ).toBe(true)
    }).pipe(
      provideLayer(
        ConfigurationService.memoryConfigurationLayer({
          global: {
            providers: { openai: { baseUrl: "https://global.models.test/v1", apiKeyEnv: "GLOBAL_MODEL_API_KEY" } },
          },
          workspace: { providers: { openai: { baseUrl: "https://workspace.models.test/v1" } } },
        }),
      ),
    ),
  )

  it.effect("falls back to built-in fields rather than the other scope when a workspace provider replaces global", () =>
    Effect.gen(function* () {
      const config = yield* ConfigurationService.effectiveConfiguration()
      expect(config.settings.providers).toEqual({
        openai: {
          protocol: "openai-responses",
          baseUrl: ConfigContract.defaults.providers.openai.baseUrl,
          apiKeyEnv: "WORKSPACE_OPENAI_KEY",
        },
        anthropic: {
          protocol: "anthropic",
          baseUrl: "https://global.anthropic.test",
          apiKeyEnv: "GLOBAL_ANTHROPIC_KEY",
        },
        bedrock: { protocol: "amazon-bedrock", authMode: "default" },
        openrouter: {
          protocol: "openrouter",
          baseUrl: ConfigContract.defaults.providers.openrouter.baseUrl,
          apiKeyEnv: "OPENROUTER_API_KEY",
          credentialIdentity: "openrouter",
        },
      })
    }).pipe(
      provideLayer(
        ConfigurationService.memoryConfigurationLayer({
          global: {
            providers: {
              openai: { baseUrl: "https://global.openai.test/v1", apiKeyEnv: "GLOBAL_OPENAI_KEY" },
              anthropic: { baseUrl: "https://global.anthropic.test", apiKeyEnv: "GLOBAL_ANTHROPIC_KEY" },
            },
          },
          workspace: { providers: { openai: { apiKeyEnv: "WORKSPACE_OPENAI_KEY" } } },
        }),
      ),
    ),
  )

  it.effect("merges custom aliases by name and model routes by leaf while inheriting built-in policy", () =>
    Effect.gen(function* () {
      const config = yield* ConfigurationService.effectiveConfiguration()
      const alias = config.settings.models["bedrock-terra"]!
      expect(alias.provider).toBe("bedrock")
      expect(alias.candidates).toEqual(["workspace-model"])
      expect(alias.displayName).toBe("Workspace Terra")
      expect(config.settings.modes.medium).toEqual({
        main: { alias: "bedrock-terra", effort: "xhigh" },
        oracle: { alias: "bedrock-terra", effort: "medium" },
        agents: {
          task: { alias: "bedrock-fable", effort: "xhigh" },
          review: { alias: "bedrock-terra", effort: "medium" },
        },
      })
      expect(config.settings.compaction).toEqual({
        summaryModel: { alias: "bedrock-fable", effort: ConfigContract.defaults.compaction.summaryModel.effort },
      })
    }).pipe(
      provideLayer(
        ConfigurationService.memoryConfigurationLayer({
          global: {
            modelAliases: {
              "bedrock-terra": {
                preset: "openai",
                displayName: "Global Terra",
                provider: "bedrock",
                candidates: ["global-model"],
              },
              "bedrock-fable": {
                preset: "claude",
                displayName: "Bedrock Fable",
                provider: "bedrock",
                candidates: ["fable-model"],
              },
            },
            modes: {
              medium: {
                main: { alias: "bedrock-terra", effort: "xhigh" },
                agents: { task: { alias: "bedrock-fable" } },
              },
            },
            modelRoutes: { compaction: { alias: "bedrock-fable" } },
          },
          workspace: {
            modelAliases: {
              "bedrock-terra": {
                preset: "openai",
                displayName: "Workspace Terra",
                provider: "bedrock",
                candidates: ["workspace-model"],
              },
            },
            modes: {
              medium: {
                oracle: { alias: "bedrock-terra", effort: "medium" },
                agents: { review: { alias: "bedrock-terra" } },
              },
            },
          },
        }),
      ),
    ),
  )

  it.effect("does not inspect or project ambient AWS credentials", () =>
    Effect.gen(function* () {
      const config = yield* ConfigurationService.effectiveConfiguration()
      expect(config.environment.providerCredentials).toEqual({})
      expect(yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(config)).not.toContain(
        "aws-secret-must-not-leak",
      )
    }).pipe(
      provideLayer(
        ConfigurationService.liveConfigurationLayer({ webProviders }).pipe(
          Layer.provide(
            ConfigProvider.layer(
              ConfigProvider.fromEnv({
                env: {
                  AWS_ACCESS_KEY_ID: "aws-access-must-not-leak",
                  AWS_SECRET_ACCESS_KEY: "aws-secret-must-not-leak",
                  AWS_SESSION_TOKEN: "aws-session-must-not-leak",
                },
              }),
            ),
          ),
        ),
      ),
    ),
  )

  it.effect("does not send the built-in provider credential to an overridden endpoint", () =>
    Effect.gen(function* () {
      const config = yield* ConfigurationService.effectiveConfiguration()
      expect(config.settings.providers.openai).toEqual({
        protocol: "openai-responses",
        baseUrl: "https://workspace.models.test/v1",
      })
      expect(config.environment.providerCredentials).toEqual({})
    }).pipe(
      provideLayer(
        ConfigurationService.liveConfigurationLayer({
          webProviders,
          workspace: { providers: { openai: { baseUrl: "https://workspace.models.test/v1" } } },
        }).pipe(
          Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: { OPENAI_API_KEY: "must-not-be-read" } }))),
        ),
      ),
    ),
  )

  it.effect("reads only configured provider API-key environment references and keeps values redacted", () => {
    const secret = "configured-secret-must-not-leak"
    const layer = ConfigurationService.liveConfigurationLayer({
      webProviders,
      global: { providers: { openai: { apiKeyEnv: "RIKA_MODEL_API_KEY" } } },
    }).pipe(
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({
            env: { RIKA_MODEL_API_KEY: secret, OPENAI_API_KEY: "must-not-be-read", ANTHROPIC_API_KEY: "anthropic" },
          }),
        ),
      ),
    )
    return Effect.gen(function* () {
      const effective = yield* Effect.scoped(
        Layer.build(layer).pipe(
          Effect.map((context) => Context.get(context, ConfigurationService.ConfigurationService)),
        ),
      ).pipe(Effect.flatMap((service: ConfigurationService.ConfigurationServiceContract) => service.effective))
      expect(Object.keys(effective.environment.providerCredentials).toSorted()).toEqual([
        "ANTHROPIC_API_KEY",
        "RIKA_MODEL_API_KEY",
      ])
      expect(Redacted.value(effective.environment.providerCredentials.RIKA_MODEL_API_KEY!)).toBe(secret)
      const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(effective)
      expect(encoded).not.toContain(secret)
      expect(encoded).not.toContain("must-not-be-read")
    })
  })

  it.effect("merges web search providers by ID and keeps credentials out of effective settings JSON", () => {
    const globalSecret = "global-secret-must-not-leak"
    const workspaceSecret = "workspace-secret-must-not-leak"
    return Effect.gen(function* () {
      const config = yield* ConfigurationService.effectiveConfiguration()
      expect(config.settings.webSearch.providers).toEqual({ exa: { configured: true }, custom: { configured: true } })
      expect(Redacted.value(config.environment.webSearchCredentials.exa!)).toBe(workspaceSecret)
      expect(Redacted.value(config.environment.webSearchCredentials.custom!)).toBe(globalSecret)
      const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(config)
      expect(encoded).not.toContain(globalSecret)
      expect(encoded).not.toContain(workspaceSecret)
    }).pipe(
      provideLayer(
        ConfigurationService.memoryConfigurationLayer({
          global: {
            webSearch: { providers: { exa: { apiKey: globalSecret }, custom: { apiKey: globalSecret } } },
          },
          workspace: { webSearch: { providers: { exa: { apiKey: workspaceSecret } } } },
        }),
      ),
    )
  })
})
