import { nestedProjection } from "./transcript-fixture-checkpoints"
import * as TranscriptProjection from "@rika/transcript/transcript-projection"
import { expect, it } from "@effect/vitest"
import { Effect } from "effect"
import * as TranscriptRepository from "../src/transcript/sqlite-transcript-repository"
import * as TurnRepository from "../src/turn/sqlite-turn-repository"
import { commitAll, event, executionCheckpoint, projectionVersion, turn } from "./transcript-repository-fixtures"

const _compareExecutionCheckpoints = (
  left: TranscriptRepository.ExecutionCheckpoint,
  right: TranscriptRepository.ExecutionCheckpoint,
): number => {
  if (left.executionKey < right.executionKey) return -1
  if (left.executionKey > right.executionKey) return 1
  return 0
}

it.effect("lists terminal roots whose current projection has an unfinished child", () =>
  Effect.gen(function* () {
    const target = turn(700)
    const turns = yield* TurnRepository.makeMemory([target])
    const repository = yield* TranscriptRepository.makeMemory({ turns })
    const nested = nestedProjection(target, "child:turn-700:parent")

    expect(yield* repository.listProjectionRecoveryCandidates(projectionVersion)).toEqual([
      { threadId: target.threadId, turnId: target.id },
    ])
    expect(
      yield* commitAll(repository, target, nested.projection, undefined, projectionVersion, nested.checkpoints),
    ).toBe("committed")
    expect(yield* repository.listProjectionRecoveryCandidates(projectionVersion)).toEqual([
      { threadId: target.threadId, turnId: target.id },
    ])

    const stored = yield* repository.get(target.id)
    if (stored === undefined) return yield* Effect.die("nested projection was not stored")
    const terminal = nested.checkpoints.map((checkpoint) =>
      checkpoint.attachment === undefined ? checkpoint : { ...checkpoint, status: "completed" as const },
    )
    expect(
      yield* repository.commitDelta(
        target,
        TranscriptProjection.Projection.projectionState(nested.projection),
        { upsert: [], remove: [] },
        {
          executionCheckpoints: terminal,
          projectionVersion,
          expectedGeneration: stored.checkpointGeneration,
        },
      ),
    ).toBe("committed")
    expect(yield* repository.listProjectionRecoveryCandidates(projectionVersion)).toEqual([])
  }),
)

it.effect("loads a migration-invalidated empty projection for authoritative refold", () =>
  Effect.gen(function* () {
    expect(TranscriptRepository.invalidatedProjectionVersion).toBe(2)
    const target = turn(0)
    const invalidated: TranscriptRepository.Projection = {
      turn: target,
      units: [],
      checkpointGeneration: 4,
      revision: 9,
      modelPhase: -1,
      usableCompletionSequence: undefined,
      oldestCursor: undefined,
      checkpointCursor: undefined,
      costUsd: undefined,
      usageCursors: undefined,
      pricingVersion: undefined,
      executionCheckpoints: [],
      projectionVersion: TranscriptRepository.invalidatedProjectionVersion,
    }
    const repository = yield* TranscriptRepository.makeMemory({ initial: [invalidated] })
    expect(yield* repository.get(target.id)).toEqual(invalidated)
    expect(
      (yield* Effect.result(TranscriptRepository.makeMemory({ initial: [{ ...invalidated, revision: -2 }] })))._tag,
    ).toBe("Failure")

    const replacement = TranscriptProjection.Projection.project(target.id, target.prompt, [
      event(0),
      event(1),
      event(2),
    ])
    expect(
      yield* repository.replaceForRefold(target, replacement, {
        executionCheckpoints: [executionCheckpoint(target, replacement, "completed")],
        projectionVersion,
        expectedProjectionVersion: TranscriptRepository.invalidatedProjectionVersion,
        expectedGeneration: invalidated.checkpointGeneration,
      }),
    ).toMatchObject({ _tag: "Committed" })
    expect(yield* repository.get(target.id)).toMatchObject({
      units: replacement.units,
      checkpointGeneration: 5,
      projectionVersion,
    })
  }),
)

it.effect("authoritatively adopts corrected terminal outcomes in paired memory repositories", () =>
  Effect.gen(function* () {
    for (const [index, status, type] of [
      [100, "failed", "execution.failed"],
      [101, "cancelled", "execution.cancelled"],
    ] as const) {
      const target = turn(index)
      const obsolete = TranscriptProjection.Projection.project(target.id, target.prompt, [event(0), event(1)])
      const turns = yield* TurnRepository.makeMemory([target])
      const repository = yield* TranscriptRepository.makeMemory({ turns })
      yield* commitAll(repository, target, obsolete, undefined, 2)
      const before = yield* repository.get(target.id)
      if (before === undefined) return yield* Effect.die("obsolete projection was not stored")
      const replacement = TranscriptProjection.Projection.project(target.id, target.prompt, [
        {
          cursor: `${status}-cursor`,
          sequence: 0,
          type,
          createdAt: 10,
          ...(status === "failed" ? { text: "failed" } : {}),
        },
      ])
      const options = {
        executionCheckpoints: [executionCheckpoint(target, replacement, status)],
        projectionVersion,
        expectedProjectionVersion: 2,
        expectedGeneration: before.checkpointGeneration,
      }
      const committed = yield* repository.replaceForRefold(target, replacement, options)
      expect(committed).toMatchObject({ _tag: "Committed", turn: { status, lastCursor: `${status}-cursor` } })
      expect(yield* turns.get(target.id)).toMatchObject({ status, lastCursor: `${status}-cursor` })
      expect(yield* repository.get(target.id)).toMatchObject({
        turn: { status, lastCursor: `${status}-cursor` },
        units: replacement.units,
      })
      expect(
        yield* repository.replaceForRefold(target, replacement, {
          ...options,
          projectionVersion: projectionVersion + 1,
          expectedProjectionVersion: projectionVersion,
          expectedGeneration: before.checkpointGeneration + 1,
        }),
      ).toEqual({ _tag: "Stale" })
      expect(yield* turns.get(target.id)).toMatchObject({ status, lastCursor: `${status}-cursor` })
    }
  }),
)
