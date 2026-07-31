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
      expect(route.alias).toBe("gate-sonnet")
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
            modelRoutes: { title: "gate-sonnet" },
          },
        }),
      ),
    ),
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

  it.effect("keeps base-derived aliases working and reports them as deprecated", () =>
    Effect.gen(function* () {
      const config = yield* ConfigurationService.effectiveConfiguration()
      const alias = config.settings.models["legacy-sonnet"]!
      expect(alias.limits).toEqual(ConfigContract.defaults.models.fable!.limits)
      expect(alias.displayName).toBe("legacy-sonnet")
      expect(config.diagnostics).toContainEqual({
        path: "modelAliases.legacy-sonnet.base",
        source: "global",
        message: 'deprecated base "fable"; replace with preset "claude" and set displayName',
      })
    }).pipe(
      provideLayer(
        ConfigurationService.memoryConfigurationLayer({
          global: {
            modelAliases: {
              "legacy-sonnet": { base: "fable", provider: "bedrock", candidates: ["us.anthropic.claude-sonnet-5"] },
            },
          },
        }),
      ),
    ),
  )
})
