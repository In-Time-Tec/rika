import * as BunServices from "@effect/platform-bun/BunServices"
import { expect, it } from "@effect/vitest"
import * as TranscriptProjection from "@rika/transcript/transcript-projection"
import { Effect, FileSystem } from "effect"
import * as Thread from "@rika/product/thread-record"
import * as ThreadRepository from "../../src/thread/sqlite-thread-repository"
import * as TranscriptRepository from "../../src/transcript/sqlite-transcript-repository"
import * as TurnRepository from "../../src/turn/sqlite-turn-repository"
import * as Turn from "@rika/product/turn-record"
import * as ExecutionRouteSnapshot from "@rika/product/execution-route-snapshot"
import {
  commitAll,
  nestedProjection,
  projectionVersion,
  provideLayer,
  sqliteLayer,
} from "../transcript-repository-fixtures"

const createTurn = Effect.fn("TranscriptCheckpointDeltaTest.createTurn")(function* () {
  const threads = yield* ThreadRepository.Service
  const turns = yield* TurnRepository.Service
  const threadId = Thread.ThreadId.make("thread-checkpoint-delta")
  const turnId = Turn.TurnId.make("turn-checkpoint-delta")
  yield* threads.create({ id: threadId, workspace: "/work/checkpoint-delta", title: "Checkpoint delta", now: 1 })
  yield* turns.createForSubmission({
    id: turnId,
    threadId,
    prompt: "delegate",
    executionRoute: ExecutionRouteSnapshot.testExecutionRoute(),
    queueCapacity: 128,
    now: 2,
  })
  return yield* turns.setStatus(turnId, "completed", undefined, 3)
})

it.effect("merges stored child checkpoints when a SQLite delta supplies the root and a child unit", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-checkpoint-delta-" })
      const filename = `${directory}/rika.db`

      yield* Effect.scoped(
        Effect.gen(function* () {
          const repository = yield* TranscriptRepository.Service
          const target = yield* createTurn()
          const nested = nestedProjection(target, "child:turn-checkpoint-delta:root-subset")
          expect(
            yield* commitAll(repository, target, nested.projection, undefined, projectionVersion, nested.checkpoints),
          ).toBe("committed")

          const before = yield* repository.get(target.id)
          const root = nested.checkpoints[0]
          const child = nested.checkpoints[1]
          const childUnit = nested.projection.units.find((unit) => unit.parentId !== undefined)
          if (before === undefined || root === undefined || child === undefined || childUnit === undefined)
            return yield* Effect.die("nested transcript was not stored")

          expect(
            yield* repository.commitDelta(
              target,
              TranscriptProjection.Projection.projectionState(nested.projection),
              { upsert: [childUnit], remove: [] },
              {
                executionCheckpoints: [root],
                projectionVersion,
                expectedGeneration: before.checkpointGeneration,
              },
            ),
          ).toBe("committed")

          const stored = yield* repository.get(target.id)
          expect(stored?.executionCheckpoints).toEqual(expect.arrayContaining([root, child]))
          expect(stored?.checkpointGeneration).toBe(before.checkpointGeneration + 1)
        }).pipe(provideLayer(sqliteLayer(filename))),
      )
    }),
  ).pipe(provideLayer(BunServices.layer)),
)

it.effect("merges a child-only SQLite checkpoint delta with its stored root", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-checkpoint-delta-" })
      const filename = `${directory}/rika.db`

      yield* Effect.scoped(
        Effect.gen(function* () {
          const repository = yield* TranscriptRepository.Service
          const target = yield* createTurn()
          const nested = nestedProjection(target, "child:turn-checkpoint-delta:parent")
          expect(
            yield* commitAll(repository, target, nested.projection, undefined, projectionVersion, nested.checkpoints),
          ).toBe("committed")

          const before = yield* repository.get(target.id)
          const root = nested.checkpoints[0]
          const child = nested.checkpoints[1]
          if (before === undefined || root === undefined || child === undefined)
            return yield* Effect.die("nested transcript was not stored")

          expect(
            yield* repository.commitDelta(
              target,
              TranscriptProjection.Projection.projectionState(nested.projection),
              { upsert: [], remove: [] },
              {
                executionCheckpoints: [{ ...child, status: "completed" }],
                projectionVersion,
                expectedGeneration: before.checkpointGeneration,
              },
            ),
          ).toBe("committed")

          const stored = yield* repository.get(target.id)
          expect(stored?.executionCheckpoints).toEqual(
            expect.arrayContaining([
              root,
              expect.objectContaining({ executionKey: child.executionKey, status: "completed" }),
            ]),
          )
          expect(stored?.checkpointGeneration).toBe(before.checkpointGeneration + 1)
          if (stored === undefined) return yield* Effect.die("child checkpoint delta was not stored")

          const contradictory = yield* Effect.result(
            repository.commitDelta(
              target,
              {
                ...TranscriptProjection.Projection.projectionState(nested.projection),
                revision: nested.projection.revision + 1,
              },
              { upsert: [], remove: [] },
              {
                executionCheckpoints: [{ ...child, status: "completed" }],
                projectionVersion,
                expectedGeneration: stored.checkpointGeneration,
              },
            ),
          )
          expect(contradictory._tag).toBe("Failure")
          if (contradictory._tag === "Failure")
            expect(contradictory.failure.message).toContain("contradictory root fold state")
          expect(yield* repository.get(target.id)).toEqual(stored)
        }).pipe(provideLayer(sqliteLayer(filename))),
      )
    }),
  ).pipe(provideLayer(BunServices.layer)),
)
