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
  it.effect("uses built-in providers and internal model policy when settings omit providers", () =>
    Effect.gen(function* () {
      const config = yield* ConfigService.effective()
      expect(config.settings.providers).toEqual(ConfigContract.defaults.providers)
      expect(config.settings.models).toBe(ConfigContract.defaults.models)
      expect(config.settings.modes).toBe(ConfigContract.defaults.modes)
      expect(config.settings.agents).toBe(ConfigContract.defaults.agents)
      expect(config.settings.compaction).toBe(ConfigContract.defaults.compaction)
      expect(config.environment.providerCredentials).toEqual({})
    }).pipe(provideLayer(ConfigService.memoryLayer())),
  )

  it.effect("replaces a global provider override at workspace scope without inheriting its credential", () =>
    Effect.gen(function* () {
      const config = yield* ConfigService.effective()
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
        ConfigContract.resolveAgentRoute(config.settings, "task"),
      ]
      expect(routes.every((route) => route.providerConnection === config.settings.providers.openai)).toBe(true)
      expect(routes.map((route) => route.providerConnection.baseUrl)).toEqual(
        Array.from({ length: routes.length }, () => "https://workspace.models.test/v1"),
      )
    }).pipe(
      provideLayer(
        ConfigService.memoryLayer({
          global: {
            providers: { openai: { baseUrl: "https://global.models.test/v1", apiKeyEnv: "GLOBAL_MODEL_API_KEY" } },
          },
          workspace: { providers: { openai: { baseUrl: "https://workspace.models.test/v1" } } },
        }),
      ),
    ),
  )

  it.effect("does not send the built-in provider credential to an overridden endpoint", () =>
    Effect.gen(function* () {
      const config = yield* ConfigService.effective()
      expect(config.settings.providers.openai).toEqual({
        protocol: "openai",
        baseUrl: "https://workspace.models.test/v1",
      })
      expect(config.environment.providerCredentials).toEqual({})
    }).pipe(
      provideLayer(
        ConfigService.liveEnvironmentLayer({
          workspace: { providers: { openai: { baseUrl: "https://workspace.models.test/v1" } } },
        }).pipe(
          Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: { OPENAI_API_KEY: "must-not-be-read" } }))),
        ),
      ),
    ),
  )

  it.effect("reads only configured provider API-key environment references and keeps values redacted", () => {
    const secret = "configured-secret-must-not-leak"
    const layer = ConfigService.liveEnvironmentLayer({
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
        Layer.build(layer).pipe(Effect.map((context) => Context.get(context, ConfigService.Service))),
      ).pipe(Effect.flatMap((service: ConfigService.Interface) => service.effective))
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

  it.effect("merges intentionally configurable product settings and reports credential presence", () =>
    Effect.gen(function* () {
      const config = yield* ConfigService.effective()
      expect(config.settings.keymap.submit).toBe("ctrl+enter")
      expect(config.settings.notifications.enabled).toBe(false)
      expect(config.settings.mcp.docs).toMatchObject({ transport: "remote" })
      expect(config.diagnostics.map((diagnostic) => diagnostic.path)).toEqual([
        "keymap",
        "mcp",
        "notifications",
        "parallelApiKey",
        "providerCredentials.RIKA_MODEL_API_KEY",
      ])
    }).pipe(
      provideLayer(
        ConfigService.testLayer({
          workspace: {
            keymap: { submit: "ctrl+enter" },
            notifications: { enabled: false },
            mcp: { docs: { transport: "remote", url: "https://example.test/mcp", headers: {}, enabled: true } },
          },
          environment: {
            parallelApiKey: Redacted.make("parallel-secret"),
            providerCredentials: { RIKA_MODEL_API_KEY: Redacted.make("model-secret") },
          },
        }),
      ),
    ),
  )
})
