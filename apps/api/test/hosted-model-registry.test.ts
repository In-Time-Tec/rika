import { Context, Effect, Layer } from "effect"
import { expect, it } from "@effect/vitest"
import { HostedModelRegistry, layer } from "../src/hosted-model-registry"
import { HostedProviderCredentials } from "../src/hosted-provider-credentials"

it.effect("pins every hosted mode to the owner's OpenAI account", () =>
  Effect.gen(function* () {
    const required: Array<string> = []
    const credentials = HostedProviderCredentials.of({
      put: () => Effect.die("unused"),
      revoke: () => Effect.die("unused"),
      list: () => Effect.die("unused"),
      require: () => Effect.die("unused"),
      putOpenAiAccount: () => Effect.die("unused"),
      revokeOpenAiAccount: () => Effect.die("unused"),
      openAiAccountStatus: () => Effect.die("unused"),
      requireOpenAiAccount: (ownerId) =>
        Effect.sync(() => {
          required.push(ownerId)
          return {
            state: "active" as const,
            revision: "1",
            credentialIdentity: `credential:${ownerId}:openai-account`,
            fingerprint: `fingerprint:${ownerId}`,
          }
        }),
      openAiAccountAccess: () => ({ acquire: Effect.die("unused"), refreshRejected: () => Effect.die("unused") }),
    })
    const context = yield* Layer.build(
      layer().pipe(Layer.provide(Layer.succeed(HostedProviderCredentials, credentials))),
    )
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
          expect(candidate.providerConnection.provider).toBe("openai")
          expect(candidate.providerConnection.authentication).toBe("account")
          expect(candidate.providerConnection.credentialIdentity).toBe("credential:owner-1:openai-account")
          expect(candidate.providerConnection.accountFingerprint).toBe("fingerprint:owner-1")
        }
      }
    }
    expect(required).toEqual(["owner-1", "owner-1", "owner-1", "owner-1"])
  }),
)

it.effect("pins development routes to the owner's encrypted OpenRouter credential", () =>
  Effect.gen(function* () {
    const required: Array<readonly [string, string]> = []
    const credentials = HostedProviderCredentials.of({
      put: () => Effect.die("unused"),
      revoke: () => Effect.die("unused"),
      list: () => Effect.die("unused"),
      require: (ownerId, provider) =>
        Effect.sync(() => {
          required.push([ownerId, provider])
          return {
            provider,
            state: "active" as const,
            revision: "1",
            credentialIdentity: `credential:${ownerId}:${provider}`,
          }
        }),
      putOpenAiAccount: () => Effect.die("unused"),
      revokeOpenAiAccount: () => Effect.die("unused"),
      openAiAccountStatus: () => Effect.die("unused"),
      requireOpenAiAccount: () => Effect.die("unused"),
      openAiAccountAccess: () => ({ acquire: Effect.die("unused"), refreshRejected: () => Effect.die("unused") }),
    })
    const context = yield* Layer.build(
      layer({ developmentModel: "openrouter/free" }).pipe(
        Layer.provide(Layer.succeed(HostedProviderCredentials, credentials)),
      ),
    )
    const registry = Context.get(context, HostedModelRegistry)
    const route = yield* registry.resolve("owner-1", "medium")
    const models = [
      route.main,
      route.oracle,
      route.title,
      route.compactionSummary,
      ...Object.values(route.agents ?? {}),
    ]
    for (const resolved of models) {
      for (const candidate of resolved.candidates) {
        expect(candidate.model).toBe("openrouter/free")
        expect(candidate.providerConnection).toMatchObject({
          provider: "openrouter",
          authentication: "api-key",
          credentialIdentity: "credential:owner-1:openrouter",
        })
      }
    }
    expect(required).toEqual([["owner-1", "openrouter"]])
  }),
)
