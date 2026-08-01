import { nestedProjection } from "./transcript-fixture-checkpoints"
import {
  expect,
  it,
  BunServices,
  TranscriptProjection,
  Effect,
  FileSystem,
  Thread,
  TranscriptRepository,
  Turn,
  createTurn,
  commitAll,
  projectionVersion,
  provideLayer,
  sqliteLayer,
} from "./transcript-sqlite-support"

it.effect("lists terminal roots whose current SQLite projection has an unfinished child", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-transcript-recovery-" })
      const filename = `${directory}/rika.db`
      yield* Effect.scoped(
        Effect.gen(function* () {
          const repository = yield* TranscriptRepository.Service
          const target = yield* createTurn(
            Thread.ThreadId.make("thread-recovery"),
            Turn.TurnId.make("turn-recovery"),
            "recover child",
          )
          const nested = nestedProjection(target, "child:turn-recovery:parent")

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
        }).pipe(provideLayer(sqliteLayer(filename))),
      )
    }),
  ).pipe(provideLayer(BunServices.layer)),
)
