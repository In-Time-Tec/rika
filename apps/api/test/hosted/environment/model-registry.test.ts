import { Context, Effect, Layer } from "effect"
import { expect, it } from "@effect/vitest"
import { HostedModelRegistry, layer } from "../../../src/hosted/environment/model-registry"
import { HostedProviderCredentials } from "../../../src/hosted/environment/provider-credentials"

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
    const high = yield* registry.resolve("owner-1", "high")
    expect(high.main).toMatchObject({
      selection: "astra",
      effort: "medium",
      compaction: { contextWindow: 1_050_000, reserveTokens: 128_000, keepRecentTokens: 32_000 },
      candidates: [{ model: "gpt-6-astra", providerOptions: { reasoning: { effort: "medium", summary: "auto" } } }],
    })
    expect(high.oracle).toMatchObject({
      selection: "astra",
      effort: "high",
      candidates: [{ model: "gpt-6-astra", providerOptions: { reasoning: { effort: "high", summary: "auto" } } }],
    })
    const ultra = yield* registry.resolve("owner-1", "ultra")
    expect(ultra.main).toMatchObject({
      selection: "astra",
      effort: "xhigh",
      candidates: [{ model: "gpt-6-astra", providerOptions: { reasoning: { effort: "xhigh", summary: "auto" } } }],
    })
    expect(ultra.oracle).toMatchObject({
      selection: "astra",
      effort: "max",
      compaction: { contextWindow: 1_050_000, reserveTokens: 128_000, keepRecentTokens: 32_000 },
      candidates: [{ model: "gpt-6-astra", providerOptions: { reasoning: { effort: "max", summary: "auto" } } }],
    })
    expect(required).toEqual(["owner-1", "owner-1", "owner-1", "owner-1", "owner-1", "owner-1"])
    // A mode declared only in a Workspace settings file is refused by name, before any credential lookup.
    const refused = yield* registry.resolve("owner-1", "load").pipe(Effect.flip)
    expect(refused.kind).toBe("invalid")
    expect(refused.message).toBe('Mode "load" is not a hosted mode; hosted modes are low, medium, high, ultra')
    expect(required).toHaveLength(6)
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
