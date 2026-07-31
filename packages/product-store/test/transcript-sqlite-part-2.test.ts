import {
  expect,
  it,
  BunServices,
  TranscriptProjection,
  Effect,
  FileSystem,
  Thread,
  TranscriptRepository,
  TurnRepository,
  Turn,
  createTurn,
  commitAll,
  event,
  executionCheckpoint,
  projectionVersion,
  provideLayer,
  sqliteLayer,
} from "./transcript-sqlite-part-support"

it.effect("rejects contradictory durable checkpoint and projected terminal outcomes during refold", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-transcript-refold-contradiction-" })
      yield* Effect.scoped(
        Effect.gen(function* () {
          const repository = yield* TranscriptRepository.Service
          const turns = yield* TurnRepository.Service
          const target = yield* createTurn(
            Thread.ThreadId.make("thread-refold-contradiction"),
            Turn.TurnId.make("turn-refold-contradiction"),
            "refold contradiction",
          )
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
          if (rejected._tag === "Failure")
            expect(rejected.failure.message).toContain("contradictory terminal root outcomes")
          expect(yield* turns.get(target.id)).toEqual(target)
          expect(yield* repository.get(target.id)).toEqual(before)
        }).pipe(provideLayer(sqliteLayer(`${directory}/rika.db`))),
      )
    }),
  ).pipe(provideLayer(BunServices.layer)),
)
