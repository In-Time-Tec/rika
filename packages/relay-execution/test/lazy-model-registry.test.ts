import { ModelRegistry } from "@batonfx/core"
import { describe, expect, it } from "@effect/vitest"
import { Context, Effect, Exit, Fiber, Layer, Ref, Scope } from "effect"
import { LanguageModel, Model } from "effect/unstable/ai"
import { lazyModelRegistryLayer } from "../src/model/routing/relay-model-registry"

const registration = (
  provider: string,
  model: string,
  acquired: Ref.Ref<Array<string>>,
  released: Ref.Ref<Array<string>>,
): ModelRegistry.Registration => ({
  provider,
  model,
  registrationKey: `${provider}:${model}`,
  layer: Layer.effect(
    LanguageModel.LanguageModel,
    Effect.acquireRelease(
      Ref.update(acquired, (values) => [...values, provider]).pipe(
        Effect.as({ provider } as unknown as LanguageModel.Service),
      ),
      () => Ref.update(released, (values) => [...values, provider]),
    ),
  ).pipe(
    Layer.provideMerge(Layer.succeed(Model.ProviderName, provider)),
    Layer.provideMerge(Layer.succeed(Model.ModelName, model)),
  ),
})

describe("lazyModelRegistryLayer", () => {
  it.effect("acquires on first use, reuses by identity, isolates providers, and releases at shutdown", () =>
    Effect.gen(function* () {
      const acquired = yield* Ref.make<Array<string>>([])
      const released = yield* Ref.make<Array<string>>([])
      const scope = yield* Scope.make()
      const context = yield* Layer.buildWithScope(
        lazyModelRegistryLayer([
          registration("alpha", "main", acquired, released),
          registration("beta", "main", acquired, released),
        ]),
        scope,
      )
      const registry = Context.get(context, ModelRegistry.ModelRegistry)
      expect(yield* Ref.get(acquired)).toEqual([])
      expect(yield* registry.registrations).toHaveLength(2)
      expect(yield* Ref.get(acquired)).toEqual([])
      const use = (provider: string) =>
        registry.operate(
          { provider, model: "main", registrationKey: `${provider}:main` },
          LanguageModel.LanguageModel.pipe(
            Effect.map((service) => (service as unknown as { provider: string }).provider),
          ),
        )
      expect(yield* use("alpha")).toBe("alpha")
      expect(yield* use("alpha")).toBe("alpha")
      expect(yield* Ref.get(acquired)).toEqual(["alpha"])
      expect(yield* use("beta")).toBe("beta")
      expect(yield* Ref.get(acquired)).toEqual(["alpha", "beta"])
      const interrupted = yield* Effect.forkChild(
        registry.operate({ provider: "alpha", model: "main", registrationKey: "alpha:main" }, Effect.never),
      )
      yield* Fiber.interrupt(interrupted)
      expect(yield* Ref.get(released)).toEqual([])
      yield* Scope.close(scope, Exit.void)
      expect(yield* Ref.get(released)).toEqual(["beta", "alpha"])
    }),
  )
})
