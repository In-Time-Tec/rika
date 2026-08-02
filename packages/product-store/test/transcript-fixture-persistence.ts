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

type CommitResult = ReturnType<TranscriptRepository.Interface["commitDelta"]>

export function commitAll(
  target: Turn.AgentExecutionTurn,
  projection: TranscriptProjectionModel.Projection,
  expectedGeneration: number | undefined,
  version?: number,
  checkpoints?: ReadonlyArray<TranscriptPage.ExecutionCheckpoint>,
): (repository: TranscriptRepository.Interface) => CommitResult
export function commitAll(
  repository: TranscriptRepository.Interface,
  target: Turn.AgentExecutionTurn,
  projection: TranscriptProjectionModel.Projection,
  expectedGeneration: number | undefined,
  version?: number,
  checkpoints?: ReadonlyArray<TranscriptPage.ExecutionCheckpoint>,
): CommitResult
export function commitAll(
  repositoryOrTarget: TranscriptRepository.Interface | Turn.AgentExecutionTurn,
  targetOrProjection?: Turn.AgentExecutionTurn | TranscriptProjectionModel.Projection,
  projectionOrGeneration?: TranscriptProjectionModel.Projection | number | undefined,
  expectedGenerationOrVersion?: number | undefined,
  versionOrCheckpoints?: number | ReadonlyArray<TranscriptPage.ExecutionCheckpoint>,
  checkpoints?: ReadonlyArray<TranscriptPage.ExecutionCheckpoint>,
): CommitResult | ((repository: TranscriptRepository.Interface) => CommitResult) {
  if ("commitDelta" in repositoryOrTarget) {
    if (
      targetOrProjection === undefined ||
      !("_tag" in targetOrProjection) ||
      projectionOrGeneration === undefined ||
      typeof projectionOrGeneration !== "object" ||
      !("units" in projectionOrGeneration) ||
      (typeof expectedGenerationOrVersion !== "number" && expectedGenerationOrVersion !== undefined)
    )
      throw new Error("Invalid transcript commit arguments")
    const target = targetOrProjection
    const projection = projectionOrGeneration
    const expectedGeneration = expectedGenerationOrVersion
    const version = typeof versionOrCheckpoints === "number" ? versionOrCheckpoints : projectionVersion
    const nextCheckpoints =
      checkpoints ??
      (Array.isArray(versionOrCheckpoints) ? versionOrCheckpoints : [executionCheckpoint(target, projection)])
    return repositoryOrTarget.commitDelta(
      target,
      TranscriptProjection.Projection.projectionState(projection),
      { upsert: projection.units, remove: [] },
      {
        executionCheckpoints: nextCheckpoints,
        projectionVersion: version,
        expectedGeneration,
      },
    )
  }
  if (
    !("_tag" in repositoryOrTarget) ||
    targetOrProjection === undefined ||
    typeof targetOrProjection !== "object" ||
    !("units" in targetOrProjection) ||
    (typeof projectionOrGeneration !== "number" && projectionOrGeneration !== undefined) ||
    (typeof expectedGenerationOrVersion !== "number" && expectedGenerationOrVersion !== undefined) ||
    (versionOrCheckpoints !== undefined && !Array.isArray(versionOrCheckpoints))
  )
    throw new Error("Invalid transcript commit arguments")
  const target = repositoryOrTarget
  const projection = targetOrProjection
  const expectedGeneration = projectionOrGeneration
  const version = expectedGenerationOrVersion ?? projectionVersion
  const nextCheckpoints = versionOrCheckpoints ?? [executionCheckpoint(target, projection)]
  return (repository) => commitAll(repository, target, projection, expectedGeneration, version, nextCheckpoints)
}

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
