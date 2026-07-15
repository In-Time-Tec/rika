import { describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Context, Effect, Function, Layer, Redacted, Schema } from "effect"
import { ConfigContract, ConfigService } from "../src/index"

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
  it.effect("decodes an absent environment secret without inventing a credential", () =>
    Effect.gen(function* () {
      const config = yield* ConfigService.effective()
      expect(config.environment.parallelApiKey).toBeUndefined()
      expect(config.environment.gatewayCredentials).toEqual({})
      const encoded = yield* Schema.encodeEffect(Schema.UnknownFromJsonString)(config)
      expect(encoded).not.toContain("PARALLEL_API_KEY")
    }).pipe(
      provideLayer(
        ConfigService.liveEnvironmentLayer().pipe(
          Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }))),
        ),
      ),
    ),
  )

  it.effect("keeps a configured environment secret redacted", () => {
    const secret = "configured-secret-must-not-leak"
    return Effect.gen(function* () {
      const config = yield* ConfigService.effective()
      expect(config.environment.parallelApiKey).toBeDefined()
      expect(Redacted.value(config.environment.parallelApiKey!)).toBe(secret)
      const encoded = yield* Schema.encodeEffect(Schema.UnknownFromJsonString)(config)
      expect(encoded).not.toContain(secret)
    }).pipe(
      provideLayer(
        ConfigService.liveEnvironmentLayer().pipe(
          Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: { PARALLEL_API_KEY: secret } }))),
        ),
      ),
    )
  })

  it.effect("keeps copied environment secrets usable after the config layer scope closes", () => {
    const layer = ConfigService.liveEnvironmentLayer().pipe(
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({ env: { OPENAI_API_KEY: "openai-secret", ANTHROPIC_API_KEY: "anthropic-secret" } }),
        ),
      ),
    )
    return Effect.gen(function* () {
      const effective = yield* Effect.scoped(
        Layer.build(layer).pipe(Effect.map((context) => Context.get(context, ConfigService.Service))),
      ).pipe(Effect.flatMap((service: ConfigService.Interface) => service.effective))
      expect(Redacted.value(effective.environment.gatewayCredentials.OPENAI_API_KEY!)).toBe("openai-secret")
      expect(Redacted.value(effective.environment.gatewayCredentials.ANTHROPIC_API_KEY!)).toBe("anthropic-secret")
    })
  })

  it.effect("resolves workspace over global over defaults deterministically", () =>
    Effect.gen(function* () {
      const config = yield* ConfigService.effective()
      expect(config.settings.logging).toEqual({ level: "debug" })
      expect(config.settings.permissions).toEqual({
        read: "deny",
        search: "allow",
        write: "allow",
        shell: "allow",
        external: "allow",
      })
      expect(config.diagnostics).toEqual([
        { path: "logging", source: "global", message: "global value applied" },
        { path: "permissions", source: "global", message: "global value applied" },
        { path: "logging", source: "workspace", message: "workspace value applied" },
        { path: "permissions", source: "workspace", message: "workspace value applied" },
      ])
    }).pipe(
      provideLayer(
        ConfigService.memoryLayer({
          global: { logging: { level: "debug" }, permissions: { read: "deny" } },
          workspace: { logging: { level: "debug" }, permissions: { shell: "allow" } },
        }),
      ),
    ),
  )

  it.effect("keeps credentials redacted and reports only their presence", () =>
    Effect.gen(function* () {
      const config = yield* ConfigService.effective()
      expect(Redacted.value(config.environment.parallelApiKey!)).toBe("secret")
      expect(Redacted.value(config.environment.gatewayCredentials.RIKA_MODEL_API_KEY!)).toBe("model-secret")
      const encoded = yield* Schema.encodeEffect(Schema.UnknownFromJsonString)(config.diagnostics)
      expect(encoded).not.toContain("secret")
      expect(config.diagnostics.map((diagnostic) => diagnostic.path)).toEqual([
        "parallelApiKey",
        "gatewayCredentials.RIKA_MODEL_API_KEY",
      ])
    }).pipe(
      provideLayer(
        ConfigService.testLayer({
          environment: {
            parallelApiKey: Redacted.make("secret"),
            gatewayCredentials: { RIKA_MODEL_API_KEY: Redacted.make("model-secret") },
          },
        }),
      ),
    ),
  )

  it.effect("merges aliases, modes, specialized agents, keymap, MCP, and notification settings", () =>
    Effect.gen(function* () {
      const config = yield* ConfigService.effective()
      expect(config.settings.models.local?.candidates).toEqual(["fake"])
      expect(config.settings.agents.librarian).toEqual({ alias: "local", effort: "medium" })
      expect(config.settings.agents.review).toEqual(ConfigContract.defaults.agents.review)
      expect(config.settings.keymap.submit).toBe("ctrl+enter")
      expect(config.settings.notifications.enabled).toBe(false)
      expect(config.settings.mcp.docs).toMatchObject({ transport: "remote" })
    }).pipe(
      provideLayer(
        ConfigService.memoryLayer({
          workspace: {
            models: { local: { ...ConfigContract.defaults.models.luna!, candidates: ["fake"] } },
            modes: { medium: ConfigContract.defaults.modes.medium },
            agents: { librarian: { alias: "local", effort: "medium" } },
            keymap: { submit: "ctrl+enter" },
            notifications: { enabled: false },
            mcp: { docs: { transport: "remote", url: "https://example.test/mcp", headers: {}, enabled: true } },
          },
        }),
      ),
    ),
  )

  it.effect("deep-merges built-in model limit overrides", () =>
    Effect.gen(function* () {
      const config = yield* ConfigService.effective()
      expect(config.settings.models.luna).toMatchObject({
        gateway: "openai",
        candidates: ["gpt-5.6-luna"],
        limits: { maxInputTokens: 500_000, maxOutputTokens: 128_000, keepRecentTokens: 32_000 },
      })
      expect(config.settings.models.luna?.variants.low?.normal.options).toEqual({
        reasoning: { effort: "low" },
      })
    }).pipe(
      provideLayer(
        ConfigService.memoryLayer({
          global: { models: { luna: { limits: { maxInputTokens: 500_000 } } } },
        }),
      ),
    ),
  )

  it.effect("resolves workspace model and provider connection over global configuration", () =>
    Effect.gen(function* () {
      const config = yield* ConfigService.effective()
      expect(ConfigContract.resolveModelRoute(config.settings, "medium")).toMatchObject({
        alias: "gateway",
        gatewayName: "vibe",
        model: "workspace-model",
        gateway: {
          protocol: "openai",
          auth: { type: "none" },
          baseUrl: "https://workspace.vibe.test/v1",
        },
      })
    }).pipe(
      provideLayer(
        ConfigService.memoryLayer({
          global: {
            gateways: {
              vibe: { protocol: "openai", auth: { type: "none" }, baseUrl: "https://global.vibe.test/v1" },
            },
            models: {
              gateway: { ...ConfigContract.defaults.models.luna!, gateway: "vibe", candidates: ["global-model"] },
            },
            modes: {
              medium: { ...ConfigContract.defaults.modes.medium, main: { alias: "gateway", effort: "medium" } },
            },
          },
          workspace: {
            gateways: {
              vibe: {
                protocol: "openai",
                auth: { type: "none" },
                baseUrl: "https://workspace.vibe.test/v1",
              },
            },
            models: {
              gateway: { ...ConfigContract.defaults.models.luna!, gateway: "vibe", candidates: ["workspace-model"] },
            },
          },
        }),
      ),
    ),
  )

  it("rejects malformed and secret-bearing JSON configuration with typed failures", () => {
    expect(() => ConfigContract.decodeSettingsInput("bad.json", { gateways: { vibe: { baseUrl: 42 } } })).toThrow(
      ConfigContract.ConfigFileError,
    )
    expect(() =>
      ConfigContract.decodeSettingsInput("secret.json", {
        gateways: {
          vibe: {
            protocol: "anthropic",
            baseUrl: "https://vibe.test",
            auth: { type: "bearer-env", apiKey: "must-not-persist" },
          },
        },
      }),
    ).toThrow(ConfigContract.ConfigFileError)
  })
})
