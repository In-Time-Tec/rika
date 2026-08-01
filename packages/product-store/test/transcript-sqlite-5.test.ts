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

it.effect("authoritatively adopts corrected durable terminal outcomes during refold", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-transcript-refold-outcome-" })
      const filename = `${directory}/rika.db`
      const threadId = Thread.ThreadId.make("thread-refold-outcome")

      yield* Effect.scoped(
        Effect.gen(function* () {
          const repository = yield* TranscriptRepository.Service
          const turns = yield* TurnRepository.Service
          for (const [suffix, status, type] of [
            ["failed", "failed", "execution.failed"],
            ["cancelled", "cancelled", "execution.cancelled"],
          ] as const) {
            const turnId = Turn.TurnId.make(`turn-refold-${suffix}`)
            const target = yield* createTurn(threadId, turnId, `refold ${suffix}`)
            const obsolete = TranscriptProjection.Projection.project(turnId, target.prompt, [event(0), event(1)])
            yield* commitAll(repository, target, obsolete, undefined, 2)
            const before = yield* repository.get(turnId)
            if (before === undefined) return yield* Effect.die("obsolete projection was not stored")
            const replacement = TranscriptProjection.Projection.project(turnId, target.prompt, [
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
            expect(yield* repository.replaceForRefold(target, replacement, options)).toMatchObject({
              _tag: "Committed",
              turn: { status, lastCursor: `${status}-cursor` },
            })
            expect(yield* turns.get(turnId)).toMatchObject({ status, lastCursor: `${status}-cursor` })
            expect(yield* repository.get(turnId)).toMatchObject({
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
          }
        }).pipe(provideLayer(sqliteLayer(filename))),
      )
    }),
  ).pipe(provideLayer(BunServices.layer)),
)
