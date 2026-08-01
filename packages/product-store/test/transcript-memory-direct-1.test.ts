import { event } from "./transcript-fixture-core"
import { executionCheckpoint } from "./transcript-fixture-checkpoints"
import { projectionVersion } from "./transcript-fixture-core"
import { turn } from "./transcript-fixture-core"
import * as TurnRepository from "../src/turn/sqlite-turn-repository"
import {
  expect,
  it,
  TranscriptProjection,
  Effect,
  TranscriptRepository,
  commitAll,
} from "./transcript-memory-behavior-support"

it.effect("rejects a refold when the paired memory Turn tuple advanced concurrently", () =>
  Effect.gen(function* () {
    const target = turn(103)
    const turns = yield* TurnRepository.makeMemory([target])
    const repository = yield* TranscriptRepository.makeMemory({ turns })
    const obsolete = TranscriptProjection.Projection.project(target.id, target.prompt, [event(0), event(1)])
    yield* commitAll(repository, target, obsolete, undefined, 2)
    const before = yield* repository.get(target.id)
    if (before === undefined) return yield* Effect.die("obsolete projection was not stored")
    expect(yield* turns.repairCursor(target.id, "completed", undefined, "newer-cursor")).toBe(true)
    const newer = yield* turns.get(target.id)
    const preserved = yield* repository.get(target.id)
    const replacement = TranscriptProjection.Projection.project(target.id, target.prompt, [
      { cursor: "refold-failed", sequence: 0, type: "execution.failed", createdAt: 10, text: "failed" },
    ])

    expect(
      yield* repository.replaceForRefold(target, replacement, {
        executionCheckpoints: [executionCheckpoint(target, replacement, "failed")],
        projectionVersion,
        expectedProjectionVersion: 2,
        expectedGeneration: before.checkpointGeneration,
      }),
    ).toEqual({ _tag: "Stale" })
    expect(yield* turns.get(target.id)).toEqual(newer)
    expect(yield* repository.get(target.id)).toEqual(preserved)
  }),
)

it.effect("rejects contradictory checkpoint and projected terminal outcomes in paired memory repositories", () =>
  Effect.gen(function* () {
    const target = turn(102)
    const turns = yield* TurnRepository.makeMemory([target])
    const repository = yield* TranscriptRepository.makeMemory({ turns })
    const obsolete = TranscriptProjection.Projection.project(target.id, target.prompt, [event(0), event(1)])
    yield* commitAll(repository, target, obsolete, undefined, 2)
    const before = yield* repository.get(target.id)
    if (before === undefined) return yield* Effect.die("obsolete projection was not stored")
    const replacement = TranscriptProjection.Projection.project(target.id, target.prompt, [
      { cursor: "cancelled", sequence: 0, type: "execution.cancelled", createdAt: 10 },
    ])
    const rejected = yield* Effect.result(
      repository.replaceForRefold(target, replacement, {
        executionCheckpoints: [executionCheckpoint(target, replacement, "failed")],
        projectionVersion,
        expectedProjectionVersion: 2,
        expectedGeneration: before.checkpointGeneration,
      }),
    )
    expect(rejected._tag).toBe("Failure")
    if (rejected._tag === "Failure") expect(rejected.failure.message).toContain("contradictory terminal root outcomes")
    expect(yield* turns.get(target.id)).toEqual(target)
    expect(yield* repository.get(target.id)).toEqual(before)
  }),
)
