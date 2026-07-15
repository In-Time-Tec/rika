import { Context, Effect, Layer, Option, Schema } from "effect"
import type { AgentProfile, Mode, Tool, UiAction } from "./plugin-api"

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

export class GenerationUnavailable extends Schema.TaggedErrorClass<GenerationUnavailable>()(
  "@rika/extensions/PluginGenerationUnavailable",
  { generation: Schema.String },
) {}

export interface Interface {
  readonly publish: (generation: Generation) => Effect.Effect<void>
  readonly current: Effect.Effect<Option.Option<Generation>>
  readonly pinned: (id: string) => Effect.Effect<Generation, GenerationUnavailable>
}

export class Service extends Context.Service<Service, Interface>()("@rika/extensions/plugin-registry/Service") {}

export const memoryLayer = Layer.sync(Service, () => {
  const generations = new Map<string, Generation>()
  let current: Generation | undefined
  return Service.of({
    publish: (generation) =>
      Effect.sync(() => void (generations.set(generation.id, generation), (current = generation))),
    current: Effect.sync(() => (current === undefined ? Option.none() : Option.some(current))),
    pinned: (id) => {
      const found = generations.get(id)
      return found === undefined ? Effect.fail(GenerationUnavailable.make({ generation: id })) : Effect.succeed(found)
    },
  })
})
