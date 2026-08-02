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

it.effect("rejects a refold when the SQLite Turn tuple advanced concurrently", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-transcript-refold-stale-turn-" })
      yield* Effect.scoped(
        Effect.gen(function* () {
          const repository = yield* TranscriptRepository.Service
          const turns = yield* TurnRepository.Service
          const target = yield* createTurn(
            Thread.ThreadId.make("thread-refold-stale-turn"),
            Turn.TurnId.make("turn-refold-stale-turn"),
            "refold stale turn",
          )
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
        }).pipe(provideLayer(sqliteLayer(`${directory}/rika.db`))),
      )
    }),
  ).pipe(provideLayer(BunServices.layer)),
)
