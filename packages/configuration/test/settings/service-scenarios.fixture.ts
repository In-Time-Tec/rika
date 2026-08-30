import "./service.harness"
import { describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Effect, Function, Layer, Redacted } from "effect"
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
            defaultMode: "high",
            modes: { high: { main: { alias: "gate-sonnet", effort: "max" } } },
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
      expect(config.settings.modes.high).toMatchObject({
        main: { provider: "openai", model: "gpt-custom", effort: "high" },
        oracle: { provider: "anthropic", model: "claude-opus-custom", effort: "max" },
      })
      expect(ConfigContract.resolveModelRoute(config.settings, "high", "oracle").effort).toBe("max")
    }).pipe(
      provideLayer(
        ConfigurationService.memoryConfigurationLayer({
          global: {
            defaultMode: "high",
            modes: {
              high: {
                main: { provider: "openai", model: "gpt-custom", effort: "high" },
                oracle: { provider: "anthropic", model: "claude-opus-custom", effort: "max" },
              },
            },
          },
        }),
      ),
    ),
  )
})
