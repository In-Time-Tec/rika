import { Context, Effect, Layer, Option, Schema } from "effect"
import * as PluginDigest from "./plugin-digest"
import * as PluginRegistry from "./plugin-registry"

export interface Pin {
  readonly generation: string
  readonly sourceDigest: string
  readonly configFingerprint: string
  readonly toolSchemaDigest: string
  readonly mcpFingerprint: string
  readonly resolvedContextDigest: string
}

export interface Activated {
  readonly pin: Pin
  readonly generation: PluginRegistry.Generation
}

export class NoGeneration extends Schema.TaggedErrorClass<NoGeneration>()(
  "@rika/extensions/NoExtensionGeneration",
  {},
) {}

export interface Interface {
  readonly future: (mcpFingerprint: string, resolvedContextDigest: string) => Effect.Effect<Activated, NoGeneration>
  readonly resume: (pin: Pin) => Effect.Effect<Activated, PluginRegistry.GenerationUnavailable>
}

export class Service extends Context.Service<Service, Interface>()("@rika/extensions/execution-extensions/Service") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const registry = yield* PluginRegistry.Service
    return Service.of({
      future: Effect.fn("ExecutionExtensions.future")(function* (mcpFingerprint, resolvedContextDigest) {
        const current = yield* registry.current
        if (Option.isNone(current)) return yield* NoGeneration.make()
        const generation = current.value
        return {
          generation,
          pin: {
            generation: generation.id,
            sourceDigest: generation.sourceDigest,
            configFingerprint: generation.configFingerprint,
            toolSchemaDigest: generation.toolSchemaDigest,
            mcpFingerprint,
            resolvedContextDigest,
          },
        }
      }),
      resume: Effect.fn("ExecutionExtensions.resume")(function* (pin) {
        const generation = yield* registry.pinned(pin.generation)
        return { pin, generation }
      }),
    })
  }),
)

export const mcpFingerprint = (fingerprints: ReadonlyArray<string>) =>
  PluginDigest.value(fingerprints.toSorted().join("\n"))
