import { describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Context, Effect, Function, Layer, Redacted, Schema } from "effect"
import * as SettingsDefaults from "./configuration-defaults"
import * as ModelResolution from "../model-routing/model-route-resolution"
import * as ConfigurationService from "./configuration-service"

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
      expect(config.environment.providerCredentials).toEqual({})
      expect(config.environment.webSearchCredentials).toEqual({})
    }).pipe(provideLayer(ConfigurationService.memoryConfigurationLayer())),
  )

  it.effect("replaces a global provider override at workspace scope without inheriting its credential", () =>
    Effect.gen(function* () {
      const config = yield* ConfigurationService.effectiveConfiguration()
      expect(config.settings.providers.openai).toEqual({
        protocol: "openai",
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
            route.compaction.contextWindow === 1_050_000 &&
            route.compaction.reserveTokens === 128_000 &&
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
          protocol: "openai",
          baseUrl: ConfigContract.defaults.providers.openai.baseUrl,
          apiKeyEnv: "WORKSPACE_OPENAI_KEY",
        },
        anthropic: {
          protocol: "anthropic",
          baseUrl: "https://global.anthropic.test",
          apiKeyEnv: "GLOBAL_ANTHROPIC_KEY",
        },
        bedrock: { protocol: "amazon-bedrock", authMode: "default" },
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
      expect(alias.limits).toEqual(ConfigContract.defaults.models.sol!.limits)
      expect(alias.variants).toEqual(ConfigContract.defaults.models.sol!.variants)
      expect(alias.displayName).toBe("bedrock-terra")
      expect(config.settings.modes.medium).toEqual({
        main: { alias: "bedrock-terra", effort: "xhigh" },
        oracle: { alias: "bedrock-terra", effort: "medium" },
      })
      expect(config.settings.compaction).toEqual({
        summaryModel: { alias: "bedrock-fable", effort: ConfigContract.defaults.compaction.summaryModel.effort },
      })
    }).pipe(
      provideLayer(
        ConfigurationService.memoryConfigurationLayer({
          global: {
            modelAliases: {
              "bedrock-terra": { base: "terra", provider: "bedrock", candidates: ["global-model"] },
              "bedrock-fable": { base: "fable", provider: "bedrock", candidates: ["fable-model"] },
            },
            modelRoutes: {
              modes: { medium: { main: "bedrock-terra" } },
              agents: { task: "bedrock-fable" },
              compaction: "bedrock-fable",
            },
          },
          workspace: {
            modelAliases: {
              "bedrock-terra": { base: "sol", provider: "bedrock", candidates: ["workspace-model"] },
            },
            modelRoutes: {
              modes: { medium: { oracle: "bedrock-terra" } },
              agents: { readThread: "bedrock-terra" },
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
      expect(yield* Schema.encodeEffect(Schema.UnknownFromJsonString)(config)).not.toContain("aws-secret-must-not-leak")
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
        protocol: "openai",
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
      ).pipe(Effect.flatMap((service: ConfigurationService.ConfigurationServiceShape) => service.effective))
      expect(Object.keys(effective.environment.providerCredentials).toSorted()).toEqual([
        "ANTHROPIC_API_KEY",
        "RIKA_MODEL_API_KEY",
      ])
      expect(Redacted.value(effective.environment.providerCredentials.RIKA_MODEL_API_KEY!)).toBe(secret)
      const encoded = yield* Schema.encodeEffect(Schema.UnknownFromJsonString)(effective)
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
      const encoded = yield* Schema.encodeEffect(Schema.UnknownFromJsonString)(config)
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

  it.effect("uses common web search environment fallbacks without replacing explicit settings", () => {
    const layer = ConfigurationService.liveConfigurationLayer({
      webProviders,
      workspace: { webSearch: { providers: { parallel: { apiKey: "settings-parallel" } } } },
    }).pipe(
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({
            env: {
              PARALLEL_API_KEY: "environment-parallel",
              EXA_API_KEY: "environment-exa",
              FIRECRAWL_API_KEY: "environment-firecrawl",
            },
          }),
        ),
      ),
    )
    return Effect.gen(function* () {
      const config = yield* ConfigurationService.effectiveConfiguration()
      expect(Object.keys(config.settings.webSearch.providers).toSorted()).toEqual(["exa", "firecrawl", "parallel"])
      expect(Object.keys(config.environment.webSearchCredentials).toSorted()).toEqual(["exa", "firecrawl", "parallel"])
      expect(Redacted.value(config.environment.webSearchCredentials.parallel!)).toBe("settings-parallel")
      expect(Redacted.value(config.environment.webSearchCredentials.exa!).length).toBeGreaterThan(0)
      expect(config.environment.webSearchCredentials.github).toBeUndefined()
    }).pipe(provideLayer(layer))
  })

  it.effect("uses installed provider descriptors and rejects configured providers that are not installed", () =>
    Effect.gen(function* () {
      const configured = yield* ConfigurationService.effectiveConfiguration().pipe(
        provideLayer(
          ConfigurationService.liveConfigurationLayer({
            webProviders: [{ id: "custom", credentialEnvironment: "CUSTOM_SEARCH_KEY" }],
          }).pipe(
            Layer.provide(
              ConfigProvider.layer(ConfigProvider.fromEnv({ env: { CUSTOM_SEARCH_KEY: "custom-secret" } })),
            ),
          ),
        ),
      )
      expect(Redacted.value(configured.environment.webSearchCredentials.custom!)).toBe("custom-secret")

      const exit = yield* Effect.exit(
        ConfigurationService.effectiveConfiguration().pipe(
          provideLayer(
            ConfigurationService.liveConfigurationLayer({
              webProviders: [{ id: "installed", credentialEnvironment: "INSTALLED_KEY" }],
              workspace: { webSearch: { providers: { missing: { apiKey: "secret" } } } },
            }),
          ),
        ),
      )
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") expect(String(exit.cause)).toContain("Unknown web search provider 'missing'")
    }),
  )

  it.effect("merges intentionally configurable product settings and reports credential presence", () =>
    Effect.gen(function* () {
      const config = yield* ConfigurationService.effectiveConfiguration()
      expect(config.settings.keymap.submit).toBe("ctrl+enter")
      expect(config.settings.notifications.enabled).toBe(false)
      expect(config.settings.mcp.docs).toMatchObject({ transport: "remote" })
      expect(config.diagnostics.map((diagnostic) => diagnostic.path)).toEqual([
        "keymap",
        "mcp",
        "notifications",
        "webSearchCredentials.parallel",
        "providerCredentials.RIKA_MODEL_API_KEY",
      ])
    }).pipe(
      provideLayer(
        ConfigurationService.testConfigurationLayer({
          workspace: {
            keymap: { submit: "ctrl+enter" },
            notifications: { enabled: false },
            mcp: { docs: { transport: "remote", url: "https://example.test/mcp", headers: {}, enabled: true } },
          },
          environment: {
            providerCredentials: { RIKA_MODEL_API_KEY: Redacted.make("model-secret") },
            webSearchCredentials: { parallel: Redacted.make("parallel-secret") },
          },
        }),
      ),
    ),
  )

  it.effect("applies workspace scalar values and merges every map-shaped setting by key", () =>
    Effect.gen(function* () {
      const config = yield* ConfigurationService.effectiveConfiguration()
      expect(config.settings.keymap).toMatchObject({ mode: "alt+m", submit: "ctrl+enter", newline: "alt+enter" })
      expect(Object.keys(config.settings.mcp).toSorted()).toEqual(["global", "shared", "workspace"])
      expect(config.settings.mcp.shared).toMatchObject({ command: "workspace-shared" })
      expect(config.settings.notifications).toEqual({ enabled: false, command: "workspace-notify" })
      expect(config.settings.extensionRoots).toEqual(["workspace-extensions"])
      expect(config.settings.logging).toEqual({ level: "error" })
    }).pipe(
      provideLayer(
        ConfigurationService.memoryConfigurationLayer({
          global: {
            keymap: { mode: "alt+m", submit: "alt+enter" },
            mcp: {
              global: { transport: "command", command: "global", args: [], environment: {}, enabled: true },
              shared: { transport: "command", command: "global-shared", args: [], environment: {}, enabled: true },
            },
            notifications: { enabled: true, command: "global-notify" },
            extensionRoots: ["global-extensions"],
            logging: { level: "warning" },
          },
          workspace: {
            keymap: { submit: "ctrl+enter", newline: "alt+enter" },
            mcp: {
              workspace: { transport: "command", command: "workspace", args: [], environment: {}, enabled: true },
              shared: { transport: "command", command: "workspace-shared", args: [], environment: {}, enabled: true },
            },
            notifications: { enabled: false, command: "workspace-notify" },
            extensionRoots: ["workspace-extensions"],
            logging: { level: "error" },
          },
        }),
      ),
    ),
  )

  it.effect("defaults streamingOnly for chatgpt.com base URLs and honors explicit overrides", () =>
    Effect.gen(function* () {
      const config = yield* ConfigurationService.effectiveConfiguration()
      expect(config.settings.providers.openai.streamingOnly).toBe(true)
      expect(config.settings.providers.anthropic.streamingOnly).toBeUndefined()
    }).pipe(
      provideLayer(
        ConfigurationService.memoryConfigurationLayer({
          global: { providers: { openai: { baseUrl: "https://chatgpt.com/backend-api/codex" } } },
        }),
      ),
    ),
  )

  it.effect("lets an explicit streamingOnly override disable base URL detection", () =>
    Effect.gen(function* () {
      const config = yield* ConfigurationService.effectiveConfiguration()
      expect(config.settings.providers.openai.streamingOnly).toBe(false)
      expect(config.settings.providers.anthropic.streamingOnly).toBe(true)
    }).pipe(
      provideLayer(
        ConfigurationService.memoryConfigurationLayer({
          global: {
            providers: {
              openai: { baseUrl: "https://chatgpt.com/backend-api/codex", streamingOnly: false },
              anthropic: { streamingOnly: true },
            },
          },
        }),
      ),
    ),
  )

  it.effect("builds a self-described alias from a preset without naming a built-in base", () =>
    Effect.gen(function* () {
      const config = yield* ConfigurationService.effectiveConfiguration()
      const alias = config.settings.models["gate-sonnet"]!
      expect(alias.displayName).toBe("Sonnet 5")
      expect(alias.provider).toBe("anthropic")
      expect(alias.candidates).toEqual(["claude-sonnet-5"])
      expect(alias.limits.keepRecentTokens).toBe(64_000)
      expect(alias.variants.high?.normal.options).toEqual({ output_config: { effort: "high" } })
      expect(alias.variants.high?.fast).toBeUndefined()
      const route = ConfigContract.resolveModelRoute(config.settings, "high")
      expect(route.displayName).toBe("Sonnet 5")
      expect(route.effort).toBe("max")
    }).pipe(
      provideLayer(
        ConfigurationService.memoryConfigurationLayer({
          global: {
            modelAliases: {
              "gate-sonnet": {
                preset: "claude",
                provider: "anthropic",
                candidates: ["claude-sonnet-5"],
                displayName: "Sonnet 5",
              },
            },
            modelRoutes: { modes: { high: { main: { alias: "gate-sonnet", effort: "max" } } } },
          },
        }),
      ),
    ),
  )

  it.effect("accepts an alias that declares its own limits and efforts", () =>
    Effect.gen(function* () {
      const config = yield* ConfigurationService.effectiveConfiguration()
      const alias = config.settings.models["gate-custom"]!
      expect(alias.limits).toEqual({ maxInputTokens: 900_000, maxOutputTokens: 32_000, keepRecentTokens: 48_000 })
      expect(alias.variants.medium?.normal.options).toEqual({ output_config: { effort: "medium" } })
      expect(alias.displayName).toBe("gate-custom")
    }).pipe(
      provideLayer(
        ConfigurationService.memoryConfigurationLayer({
          global: {
            modelAliases: {
              "gate-custom": {
                provider: "anthropic",
                candidates: ["some-new-model"],
                limits: { maxInputTokens: 900_000, maxOutputTokens: 32_000, keepRecentTokens: 48_000 },
                efforts: { medium: { normal: { options: { output_config: { effort: "medium" } } } } },
              },
            },
          },
        }),
      ),
    ),
  )

  it.effect("lets a mode route set its own reasoning effort", () =>
    Effect.gen(function* () {
      const config = yield* ConfigurationService.effectiveConfiguration()
      expect(config.settings.modes.high).toEqual({
        main: { alias: "sol", effort: "high" },
        oracle: { alias: "opus", effort: "max" },
      })
      expect(ConfigContract.resolveModelRoute(config.settings, "high", "oracle").effort).toBe("max")
    }).pipe(
      provideLayer(
        ConfigurationService.memoryConfigurationLayer({
          global: {
            modelRoutes: {
              modes: { high: { main: { alias: "sol", effort: "high" }, oracle: { alias: "opus", effort: "max" } } },
            },
          },
        }),
      ),
    ),
  )
})
