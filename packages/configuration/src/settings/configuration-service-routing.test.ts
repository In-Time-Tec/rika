import { describe, expect, it } from "@effect/vitest"
import { Effect, Function, Layer } from "effect"
import * as SettingsDefaults from "./configuration-defaults"
import * as ModelResolution from "../model-routing/model-route-resolution"
import * as ConfigurationService from "./configuration-service"

const ConfigContract = { ...SettingsDefaults, ...ModelResolution }

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

describe("ConfigService routing", () => {
  it.effect("routes thread titles to a configured alias instead of the fixed default", () =>
    Effect.gen(function* () {
      const config = yield* ConfigurationService.effectiveConfiguration()
      const route = ConfigContract.resolveThreadTitleRoute(config.settings)
      expect(route.selection).toBe("gate-sonnet")
      expect(route.displayName).toBe("Sonnet 5")
      expect(route.effort).toBe("low")
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
            modelRoutes: { title: { alias: "gate-sonnet" } },
          },
        }),
      ),
    ),
  )

  it.effect("uses a direct model route without requiring an alias", () =>
    Effect.sync(() => {
      const settings = {
        ...ConfigContract.settingsDefaults,
        modes: {
          ...ConfigContract.settingsDefaults.modes,
          low: {
            ...ConfigContract.settingsDefaults.modes.low!,
            main: { provider: "anthropic", model: "claude-opus-custom", effort: "low", fast: true } as const,
          },
        },
      }
      const route = ConfigContract.resolveModelRoute(settings, "low")
      expect(route.selection).toBe("claude-opus-custom")
      expect(route.fast).toBe(false)
      expect(route.options).toEqual({})
    }),
  )

  it.effect("resolves custom modes and direct models for every agent provider without aliases", () =>
    Effect.gen(function* () {
      const config = yield* ConfigurationService.effectiveConfiguration()
      expect(Object.keys(config.settings.modes)).toEqual(["quick", "deep-review"])
      expect(config.settings.defaultMode).toBe("deep-review")
      expect(ConfigContract.resolveModelRoute(config.settings, "quick")).toMatchObject({
        selection: "gpt-local",
        providerId: "openai",
        model: "gpt-local",
      })
      expect(ConfigContract.resolveModelRoute(config.settings, "quick", "oracle")).toMatchObject({
        selection: "claude-opus-direct",
        providerId: "anthropic",
      })
      expect(ConfigContract.resolveAgentRoute(config.settings, "quick", "task")).toMatchObject({
        selection: "us.anthropic.claude-sonnet-direct-v1:0",
        providerId: "bedrock",
      })
      expect(ConfigContract.resolveAgentRoute(config.settings, "quick", "librarian")).toMatchObject({
        selection: "openai/gpt-direct",
        providerId: "openrouter",
      })
      expect(ConfigContract.resolveAgentRoute(config.settings, "deep-review", "painter")).toMatchObject({
        selection: "claude-vision-direct",
        providerId: "anthropic",
      })
    }).pipe(
      provideLayer(
        ConfigurationService.memoryConfigurationLayer({
          global: {
            defaultMode: "deep-review",
            modes: {
              quick: {
                main: { provider: "openai", model: "gpt-local" },
                oracle: { provider: "anthropic", model: "claude-opus-direct", effort: "high" },
                agents: {
                  task: { provider: "bedrock", model: "us.anthropic.claude-sonnet-direct-v1:0" },
                  librarian: { provider: "openrouter", model: "openai/gpt-direct" },
                },
              },
              "deep-review": {
                main: { provider: "bedrock", model: "us.anthropic.claude-opus-direct-v1:0", effort: "max" },
                agents: { painter: { provider: "anthropic", model: "claude-vision-direct" } },
              },
            },
          },
        }),
      ),
    ),
  )

  it.effect("selects OpenAI Responses or Chat Completions for an arbitrary base URL", () =>
    Effect.gen(function* () {
      const responses = yield* ConfigurationService.effectiveConfiguration().pipe(
        provideLayer(
          ConfigurationService.memoryConfigurationLayer({
            global: { providers: { openai: { api: "responses", baseUrl: "https://responses.example/v1" } } },
          }),
        ),
      )
      const chat = yield* ConfigurationService.effectiveConfiguration().pipe(
        provideLayer(
          ConfigurationService.memoryConfigurationLayer({
            global: {
              providers: { openai: { api: "chat-completions", baseUrl: "https://chat.example/openai/v1" } },
            },
          }),
        ),
      )
      expect(responses.settings.providers.openai).toMatchObject({
        protocol: "openai-responses",
        baseUrl: "https://responses.example/v1",
      })
      expect(chat.settings.providers.openai).toMatchObject({
        protocol: "openai-chat-completions",
        baseUrl: "https://chat.example/openai/v1",
      })
    }),
  )

  it.effect("merges every partial Bedrock override while preserving default auth", () =>
    Effect.gen(function* () {
      const overrides = [
        { endpoint: "https://workspace.endpoint" },
        { region: "workspace-region" },
        { profile: "workspace-profile" },
        { authRefresh: { command: "refresh", args: ["--workspace"] } },
      ] as const
      for (const override of overrides) {
        const config = yield* ConfigurationService.effectiveConfiguration().pipe(
          provideLayer(
            ConfigurationService.memoryConfigurationLayer({
              global: { providers: { bedrock: { endpoint: "https://global.endpoint", region: "global-region" } } },
              workspace: { providers: { bedrock: override } },
            }),
          ),
        )
        expect(config.settings.providers.bedrock.protocol).toBe("amazon-bedrock")
        if (config.settings.providers.bedrock.protocol === "amazon-bedrock") {
          expect(config.settings.providers.bedrock.authMode).toBe("default")
          expect(config.settings.providers.bedrock).toMatchObject(override)
        }
      }
      const precedence = yield* ConfigurationService.effectiveConfiguration().pipe(
        provideLayer(
          ConfigurationService.memoryConfigurationLayer({
            global: {
              providers: {
                bedrock: {
                  endpoint: "https://global.endpoint",
                  region: "global-region",
                  profile: "global-profile",
                },
              },
            },
            workspace: {
              providers: { bedrock: { endpoint: "https://workspace.endpoint", region: "workspace-region" } },
            },
          }),
        ),
      )
      expect(precedence.settings.providers.bedrock).toEqual({
        protocol: "amazon-bedrock",
        authMode: "default",
        endpoint: "https://workspace.endpoint",
        region: "workspace-region",
        profile: "global-profile",
      })
    }),
  )
})
