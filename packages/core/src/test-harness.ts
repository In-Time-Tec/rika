import { Effect, Layer } from "effect"
import { Common } from "@rika/schema"
import { Config } from "./index"
import { Diagnostics } from "./index"
import { IdGenerator } from "./index"
import { Time } from "./index"

export interface TestServicesInput {
  readonly config?: Config.Values
  readonly env?: Record<string, string | undefined>
  readonly diagnostics?: Array<Diagnostics.Entry>
  readonly now?: Common.TimestampMillis
  readonly idStart?: number
}

export const testLayer = (input: TestServicesInput = {}) => {
  const config: Config.Values = input.config ?? {
    workspace_root: "/tmp/rika-workspace",
    data_dir: "/tmp/rika-data",
    default_mode: "smart",
  }

  return Layer.mergeAll(
    Config.layerFromValues(config, input.env),
    Diagnostics.memoryLayer(input.diagnostics ?? []),
    Time.fixedLayer(input.now ?? 0),
    IdGenerator.sequenceLayer(input.idStart),
  )
}

export const runPromise = <A, E, R>(effect: Effect.Effect<A, E, R>, layer: Layer.Layer<R>) =>
  Effect.runPromise(effect.pipe(Effect.provide(layer)))
