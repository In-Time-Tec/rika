import { expect, it } from "@effect/vitest"
import * as BunServices from "@effect/platform-bun/BunServices"
import * as TranscriptProjection from "@rika/transcript/transcript-projection"
import { Effect, FileSystem } from "effect"
import * as Thread from "@rika/product/thread-record"
import * as TranscriptRepository from "../src/transcript/sqlite-transcript-repository"
import * as TurnRepository from "../src/turn/sqlite-turn-repository"
import * as Turn from "@rika/product/turn-record"
import { createTurn } from "./transcript-sqlite-support"
import { commitAll, event, executionCheckpoint, projectionVersion, sqliteLayer } from "./transcript-repository-fixtures"
import { provideLayer } from "./sqlite-schema-support"

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
