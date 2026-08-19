import { Context, Effect, Layer, Option, Schema } from "effect"
import type { AgentProfile, Mode, Tool, UiAction } from "./plugin-contract"

export interface Generation {
  readonly id: string
  readonly sourceDigest: string
  readonly configFingerprint: string
  readonly toolSchemaDigest: string
  readonly tools: ReadonlyMap<string, Tool>
  readonly modes: ReadonlyMap<string, Mode>
  readonly agentProfiles: ReadonlyMap<string, AgentProfile>
  readonly uiActions: ReadonlyMap<string, UiAction>
  readonly diagnostics: ReadonlyArray<string>
}

export class GenerationUnavailable extends Schema.TaggedError<GenerationUnavailable>()(
  "@rika/extensions/PluginGenerationUnavailable",
  { generation: Schema.String },
) {}

export interface PluginRegistryInterface {
  readonly publish: (generation: Generation) => Effect.Effect<void>
  readonly current: Effect.Effect<Option.Option<Generation>>
  readonly pinned: (id: string) => Effect.Effect<Generation, GenerationUnavailable>
}

export class PluginRegistryService extends Context.Service<PluginRegistryService, PluginRegistryInterface>()(
  "@rika/extensions/plugin/plugin-registry/PluginRegistryService",
) {}

export const memoryLayer = Layer.sync(PluginRegistryService, () => {
  const generations = new Map<string, Generation>()
  let current: Generation | undefined
  return PluginRegistryService.of({
    publish: (generation) =>
      Effect.sync(() => void (generations.set(generation.id, generation), (current = generation))),
    current: Effect.sync(() => (current === undefined ? Option.none() : Option.some(current))),
    pinned: (id) => {
      const found = generations.get(id)
      return found === undefined ? Effect.fail(GenerationUnavailable.make({ generation: id })) : Effect.succeed(found)
    },
  })
})
