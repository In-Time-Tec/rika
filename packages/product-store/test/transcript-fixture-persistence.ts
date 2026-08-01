import * as TranscriptPage from "@rika/product/transcript-page"
import * as TranscriptProjection from "@rika/transcript/transcript-projection"
import * as TranscriptProjectionModel from "@rika/transcript/transcript-projection-model"
import { Effect, Layer } from "effect"
import * as Database from "../src/database/product-database-layer"
import * as ThreadRepository from "../src/thread/sqlite-thread-repository"
import * as TranscriptRepository from "../src/transcript/sqlite-transcript-repository"
import * as Turn from "@rika/product/turn-record"
import * as TurnRepository from "../src/turn/sqlite-turn-repository"
import { executionCheckpoint } from "./transcript-fixture-checkpoints"
import { projectionVersion } from "./transcript-fixture-core"

export const commitAll = Effect.fn("TranscriptRepositoryTest.commitAll")(function* (
  repository: TranscriptRepository.Interface,
  target: Turn.AgentExecutionTurn,
  projection: TranscriptProjectionModel.Projection,
  expectedGeneration: number | undefined,
  version: number = projectionVersion,
  checkpoints: ReadonlyArray<TranscriptPage.ExecutionCheckpoint> = [executionCheckpoint(target, projection)],
) {
  return yield* repository.commitDelta(
    target,
    TranscriptProjection.Projection.projectionState(projection),
    { upsert: projection.units, remove: [] },
    {
      executionCheckpoints: checkpoints,
      projectionVersion: version,
      expectedGeneration,
    },
  )
})

export const sqliteLayer = (filename: string) => {
  const database = Database.layer(filename)
  return Layer.mergeAll(
    database,
    ThreadRepository.layer.pipe(Layer.provide(database)),
    TurnRepository.layer.pipe(Layer.provide(database)),
    TranscriptRepository.layer.pipe(Layer.provide(database)),
  )
}

export const provideLayer =
  <ROut, E2, RIn>(layer: Layer.Layer<ROut, E2, RIn>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R | ROut>) =>
    Effect.gen(function* () {
      const context = yield* Layer.build(layer)
      return yield* effect.pipe(Effect.provide(context))
    })
