import * as ThreadResult from "@rika/product/thread-result"
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
  event,
  executionCheckpoint,
  projectionVersion,
  provideLayer,
  sqliteLayer,
} from "./transcript-sqlite-part-support"

it.effect("persists a terminal outcome appended after the initial projection", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-transcript-outcome-" })
      const filename = `${directory}/rika.db`
      const threadId = Thread.ThreadId.make("thread-outcome")
      const turnId = Turn.TurnId.make("turn-outcome")

      yield* Effect.scoped(
        Effect.gen(function* () {
          const repository = yield* TranscriptRepository.Service
          const target = yield* createTurn(threadId, turnId, "outcome")
          const initial = TranscriptProjection.Projection.project(turnId, target.prompt, [event(0)])
          yield* commitAll(repository, target, initial, undefined)
          const stored = yield* repository.get(turnId)
          if (stored === undefined) return yield* Effect.die("initial projection was not stored")
          const completed = TranscriptProjection.Projection.applyEvent(initial, event(2))
          const previous = new Map(initial.units.map((candidate) => [candidate.key, candidate]))
          const changed = completed.units.filter(
            (candidate) => JSON.stringify(candidate) !== JSON.stringify(previous.get(candidate.key)),
          )
          expect(
            yield* repository.commitDelta(
              target,
              TranscriptProjection.Projection.projectionState(completed),
              { upsert: changed, remove: [] },
              {
                executionCheckpoints: [executionCheckpoint(target, completed, "completed")],
                projectionVersion,
                expectedGeneration: stored.checkpointGeneration,
              },
            ),
          ).toBe("committed")
        }).pipe(provideLayer(sqliteLayer(filename))),
      )

      yield* Effect.scoped(
        Effect.gen(function* () {
          const repository = yield* TranscriptRepository.Service
          const reopened = yield* repository.get(turnId)
          if (reopened === undefined) return yield* Effect.die("terminal projection was not reopened")
          if (!ThreadResult.TurnResult.isAgentExecution(reopened.turn))
            return yield* Effect.die("terminal projection did not reopen an agent execution")
          expect(reopened?.units.find((candidate) => candidate.key === `turn:${turnId}:user`)).toMatchObject({
            revision: 2,
            executionOutcome: { status: "complete" },
          })
          expect(reopened.executionCheckpoints).toContainEqual(
            executionCheckpoint(reopened.turn, reopened, "completed"),
          )
        }).pipe(provideLayer(sqliteLayer(filename))),
      )
    }),
  ).pipe(provideLayer(BunServices.layer)),
)
