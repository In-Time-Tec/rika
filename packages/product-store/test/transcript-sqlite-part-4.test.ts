import {
  expect,
  it,
  BunServices,
  TranscriptProjection,
  TranscriptProjectionModel,
  Effect,
  FileSystem,
  Thread,
  TranscriptRepository,
  Turn,
  usageEvent,
  createTurn,
  commitAll,
  provideLayer,
  sqliteLayer,
} from "./transcript-sqlite-part-support"

it.effect("restores usage dedup state before a redelivered usage event", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-transcript-usage-" })
      const filename = `${directory}/rika.db`
      const threadId = Thread.ThreadId.make("thread-usage")
      const turnId = Turn.TurnId.make("turn-usage")

      yield* Effect.scoped(
        Effect.gen(function* () {
          const repository = yield* TranscriptRepository.Service
          const target = yield* createTurn(threadId, turnId, "usage")
          yield* commitAll(
            repository,
            target,
            TranscriptProjection.Projection.project(turnId, target.prompt, [usageEvent]),
            undefined,
          )
        }).pipe(provideLayer(sqliteLayer(filename))),
      )

      yield* Effect.scoped(
        Effect.gen(function* () {
          const repository = yield* TranscriptRepository.Service
          const reopened = yield* repository.get(turnId)
          if (reopened === undefined) return yield* Effect.die("usage projection was not stored")
          const resumed: TranscriptProjectionModel.Projection = {
            units: reopened.units,
            ...TranscriptProjection.Projection.projectionState(reopened),
          }
          const redelivered = TranscriptProjection.Projection.applyEvent(resumed, usageEvent)
          expect(TranscriptProjection.Projection.projectionState(redelivered)).toEqual(
            TranscriptProjection.Projection.projectionState(resumed),
          )
          expect(redelivered.usageCursors).toEqual([usageEvent.cursor])
          expect(redelivered.costUsd).toBe(resumed.costUsd)
        }).pipe(provideLayer(sqliteLayer(filename))),
      )
    }),
  ).pipe(provideLayer(BunServices.layer)),
)
