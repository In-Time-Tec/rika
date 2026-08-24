import { Context, Effect, Layer } from "effect"
import { expect, it } from "@effect/vitest"
import { HostedModelRegistry, layer } from "../../../src/hosted/environment/model-registry"
import { HostedProviderCredentials } from "../../../src/hosted/environment/provider-credentials"

it.effect("pins every hosted mode to the owner's OpenRouter credential", () =>
  Effect.gen(function* () {
    const required: Array<string> = []
    const credentials = HostedProviderCredentials.of({
      put: () => Effect.die("unused"),
      revoke: () => Effect.die("unused"),
      list: () => Effect.die("unused"),
      require: (ownerId, provider) =>
        Effect.sync(() => {
          required.push(`${ownerId}:${provider}`)
          return {
            provider,
            state: "active" as const,
            revision: "1",
            credentialIdentity: `credential:${ownerId}:${provider}`,
          }
        }),
    })
    const context = yield* Layer.build(layer.pipe(Layer.provide(Layer.succeed(HostedProviderCredentials, credentials))))
    const registry = Context.get(context, HostedModelRegistry)
    expect(registry.modes).toEqual(["low", "medium", "high", "ultra"])
    for (const mode of registry.modes) {
      const route = yield* registry.resolve("owner-1", mode)
      const models = [
        route.main,
        route.oracle,
        route.title,
        route.compactionSummary,
        ...Object.values(route.agents ?? {}),
      ]
      for (const model of models) {
        for (const candidate of model.candidates) {
          expect(candidate.providerConnection.provider).toBe("openrouter")
          expect(candidate.providerConnection.credentialIdentity).toBe("credential:owner-1:openrouter")
          expect(candidate.model).toMatch(/^openai\//u)
        }
      }
    }
    expect(required).toEqual(["owner-1:openrouter", "owner-1:openrouter", "owner-1:openrouter", "owner-1:openrouter"])
  }),
)
