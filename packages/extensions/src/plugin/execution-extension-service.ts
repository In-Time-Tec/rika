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

export class NoGeneration extends Schema.TaggedError<NoGeneration>()("@rika/extensions/NoExtensionGeneration", {}) {}

export interface ExecutionExtensionInterface {
  readonly future: (mcpFingerprint: string, resolvedContextDigest: string) => Effect.Effect<Activated, NoGeneration>
  readonly resume: (pin: Pin) => Effect.Effect<Activated, PluginRegistry.GenerationUnavailable>
}

export class ExecutionExtensionService extends Context.Service<
  ExecutionExtensionService,
  ExecutionExtensionInterface
>()("@rika/extensions/plugin/execution-extension-service/ExecutionExtensionService") {}

export const layer = Layer.effect(
  ExecutionExtensionService,
  Effect.gen(function* () {
    const registry = yield* PluginRegistry.PluginRegistryService
    return ExecutionExtensionService.of({
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
