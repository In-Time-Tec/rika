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
} from "./transcript-sqlite-support"

it.effect("replaces an invalidated SQLite projection authoritatively and persists it across reopen", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-transcript-refold-" })
      const filename = `${directory}/rika.db`
      const threadId = Thread.ThreadId.make("thread-refold")
      const turnId = Turn.TurnId.make("turn-refold")
      const replacement = TranscriptProjection.Projection.project(turnId, "refold", [event(2)])

      yield* Effect.scoped(
        Effect.gen(function* () {
          const repository = yield* TranscriptRepository.Service
          const target = yield* createTurn(threadId, turnId, "refold")
          const obsolete = {
            ...TranscriptProjection.Projection.project(turnId, target.prompt, [event(0), event(1)]),
            revision: 70,
          }
          yield* commitAll(repository, target, obsolete, undefined, 2)
          expect(
            yield* repository.replaceForRefold(target, replacement, {
              executionCheckpoints: [executionCheckpoint(target, replacement, "completed")],
              projectionVersion,
              expectedProjectionVersion: 2,
              expectedGeneration: 0,
            }),
          ).toMatchObject({ _tag: "Committed" })
          expect(
            yield* repository.replaceForRefold(target, replacement, {
              executionCheckpoints: [executionCheckpoint(target, replacement, "completed")],
              projectionVersion,
              expectedProjectionVersion: 2,
              expectedGeneration: 0,
            }),
          ).toEqual({ _tag: "Stale" })
        }).pipe(provideLayer(sqliteLayer(filename))),
      )

      yield* Effect.scoped(
        Effect.gen(function* () {
          const repository = yield* TranscriptRepository.Service
          const reopened = yield* repository.get(turnId)
          expect(reopened?.projectionVersion).toBe(projectionVersion)
          expect(reopened?.units).toEqual(replacement.units)
          expect(reopened?.revision).toBe(replacement.revision)
        }).pipe(provideLayer(sqliteLayer(filename))),
      )
    }),
  ).pipe(provideLayer(BunServices.layer)),
)
