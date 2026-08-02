import { expect, it } from "@effect/vitest"
import * as BunServices from "@effect/platform-bun/BunServices"
import * as TranscriptProjection from "@rika/transcript/transcript-projection"
import { Effect, FileSystem } from "effect"
import * as Thread from "@rika/product/thread-record"
import * as TranscriptRepository from "../src/transcript/sqlite-transcript-repository"
import * as Turn from "@rika/product/turn-record"
import { createTurn } from "./transcript-sqlite-support"
import { commitAll, projectionVersion, sqliteLayer } from "./transcript-repository-fixtures"
import { provideLayer } from "./sqlite-schema-support"

it.effect("filters every SQLite keyset page by exact projection version", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-transcript-version-filter-" })
      const filename = `${directory}/rika.db`
      const threadId = Thread.ThreadId.make("thread-version-filter")

      yield* Effect.scoped(
        Effect.gen(function* () {
          const repository = yield* TranscriptRepository.Service
          const stale = yield* createTurn(threadId, Turn.TurnId.make("turn-filter-stale"), "stale")
          const currentOlder = yield* createTurn(threadId, Turn.TurnId.make("turn-filter-current-a"), "current older")
          const currentNewer = yield* createTurn(threadId, Turn.TurnId.make("turn-filter-current-b"), "current newer")
          for (const [target, version] of [
            [stale, 2],
            [currentOlder, projectionVersion],
            [currentNewer, projectionVersion],
          ] as const)
            yield* commitAll(
              repository,
              target,
              TranscriptProjection.Projection.empty(target.id, target.prompt),
              undefined,
              version,
            )

          const newest = yield* repository.page(threadId, { limit: 1, projectionVersion })
          expect(newest.entries.map((entry) => entry.turn.id)).toEqual([currentNewer.id])
          expect(newest.hasOlder).toBe(true)
          if (newest.oldestCursor === undefined) return yield* Effect.die("filtered page had no oldest cursor")

          const older = yield* repository.page(threadId, {
            before: newest.oldestCursor,
            limit: 1,
            projectionVersion,
          })
          expect(older.entries.map((entry) => entry.turn.id)).toEqual([currentOlder.id])
          expect(older.hasOlder).toBe(false)
          if (older.newestCursor === undefined) return yield* Effect.die("filtered page had no newest cursor")

          const newer = yield* repository.page(threadId, {
            after: older.newestCursor,
            limit: 1,
            projectionVersion,
          })
          expect(newer.entries.map((entry) => entry.turn.id)).toEqual([currentNewer.id])
          expect(newer.hasNewer).toBe(false)
          expect(
            (yield* repository.page(threadId, { limit: 10, projectionVersion: 2 })).entries.map(
              (entry) => entry.turn.id,
            ),
          ).toEqual([stale.id])
          expect((yield* repository.page(threadId, { limit: 10, projectionVersion: 4 })).entries).toEqual([])
          expect(
            new Set((yield* repository.page(threadId, { limit: 10 })).entries.map((entry) => entry.turn.id)),
          ).toEqual(new Set([stale.id, currentOlder.id, currentNewer.id]))
        }).pipe(provideLayer(sqliteLayer(filename))),
      )
    }),
  ).pipe(provideLayer(BunServices.layer)),
)
