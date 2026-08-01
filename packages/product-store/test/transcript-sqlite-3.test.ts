import * as TranscriptPage from "@rika/product/transcript-page"
import { invalidCheckpointGraphs, nestedProjection } from "./transcript-fixture-checkpoints"
import type { NestedProjectionFixture } from "./transcript-fixture-checkpoints"
import * as ThreadResult from "@rika/product/thread-result"
import { expect, it } from "@effect/vitest"
import * as BunServices from "@effect/platform-bun/BunServices"
import * as TranscriptProjection from "@rika/transcript/transcript-projection"
import { Effect, FileSystem } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import * as Thread from "@rika/product/thread-record"
import * as TranscriptRepository from "../src/transcript/sqlite-transcript-repository"
import * as Turn from "@rika/product/turn-record"
import { compareExecutionCheckpoints, createTurn } from "./transcript-sqlite-support"
import { commitAll, projectionVersion, sqliteLayer } from "./transcript-repository-fixtures"
import { provideLayer } from "./sqlite-schema-support"

it.effect("atomically couples an attached child to its parent SQLite unit", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-transcript-nested-" })
      const filename = `${directory}/rika.db`
      const threadId = Thread.ThreadId.make("thread-nested")
      const turnId = Turn.TurnId.make("turn-nested")
      let before: TranscriptPage.Projection | undefined

      yield* Effect.scoped(
        Effect.gen(function* () {
          const repository = yield* TranscriptRepository.Service
          const target = yield* createTurn(threadId, turnId, "nested")
          const nested = nestedProjection(target, "child:turn-nested:parent")

          expect(
            yield* commitAll(repository, target, nested.projection, undefined, projectionVersion, nested.checkpoints),
          ).toBe("committed")
          before = yield* repository.get(turnId)
          expect(before?.executionCheckpoints).toHaveLength(2)
          expect(before?.units).toEqual(nested.projection.units)

          const removal = yield* Effect.result(
            repository.commitDelta(
              target,
              TranscriptProjection.Projection.projectionState(nested.projection),
              { upsert: [], remove: [nested.parent.key] },
              {
                executionCheckpoints: nested.checkpoints,
                projectionVersion,
                expectedGeneration: before?.checkpointGeneration,
              },
            ),
          )
          expect(removal._tag).toBe("Failure")
          if (removal._tag === "Failure") expect(removal.failure).toBeInstanceOf(TranscriptRepository.RepositoryError)
          expect(yield* repository.get(turnId)).toEqual(before)
        }).pipe(provideLayer(sqliteLayer(filename))),
      )

      yield* Effect.scoped(
        Effect.gen(function* () {
          const repository = yield* TranscriptRepository.Service
          expect(yield* repository.get(turnId)).toEqual(before)
        }).pipe(provideLayer(sqliteLayer(filename))),
      )
    }),
  ).pipe(provideLayer(BunServices.layer)),
)

it.effect("requires a complete root-connected SQLite checkpoint graph for refold", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-transcript-refold-graph-" })
      const filename = `${directory}/rika.db`
      const threadId = Thread.ThreadId.make("thread-refold-graph")
      const turnId = Turn.TurnId.make("turn-refold-graph")
      let before: TranscriptPage.Projection | undefined
      let replacement: NestedProjectionFixture | undefined

      yield* Effect.scoped(
        Effect.gen(function* () {
          const repository = yield* TranscriptRepository.Service
          const target = yield* createTurn(threadId, turnId, "refold graph")
          const obsolete = TranscriptProjection.Projection.empty(target.id, target.prompt)
          expect(yield* commitAll(repository, target, obsolete, undefined, 2)).toBe("committed")
          before = yield* repository.get(target.id)
          if (before === undefined) return yield* Effect.die("obsolete SQLite projection was not stored")
          replacement = nestedProjection(target, "child:turn-refold-graph:parent")

          for (const candidate of invalidCheckpointGraphs(target, replacement, "child:turn-refold-graph:peer")) {
            const result = yield* Effect.result(
              repository.replaceForRefold(target, replacement.projection, {
                executionCheckpoints: candidate.checkpoints,
                projectionVersion,
                expectedProjectionVersion: 2,
                expectedGeneration: before.checkpointGeneration,
              }),
            )
            expect(result._tag, candidate.name).toBe("Failure")
            if (result._tag === "Failure")
              expect(result.failure, candidate.name).toBeInstanceOf(TranscriptRepository.RepositoryError)
            expect(yield* repository.get(target.id), candidate.name).toEqual(before)
          }
        }).pipe(provideLayer(sqliteLayer(filename))),
      )

      yield* Effect.scoped(
        Effect.gen(function* () {
          if (before === undefined || replacement === undefined)
            return yield* Effect.die("refold graph fixture was not retained")
          if (!ThreadResult.TurnResult.isAgentExecution(before.turn))
            return yield* Effect.die("refold graph fixture did not retain an agent execution")
          const repository = yield* TranscriptRepository.Service
          const sql = yield* SqlClient
          expect(yield* repository.get(turnId)).toEqual(before)
          expect(
            yield* repository.replaceForRefold(before.turn, replacement.projection, {
              executionCheckpoints: replacement.checkpoints,
              projectionVersion,
              expectedProjectionVersion: 2,
              expectedGeneration: before.checkpointGeneration,
            }),
          ).toMatchObject({ _tag: "Committed" })
          expect(yield* sql`PRAGMA foreign_key_check`).toEqual([])
        }).pipe(provideLayer(sqliteLayer(filename))),
      )

      yield* Effect.scoped(
        Effect.gen(function* () {
          if (replacement === undefined) return yield* Effect.die("refold graph fixture was not retained")
          const repository = yield* TranscriptRepository.Service
          const reopened = yield* repository.get(turnId)
          expect(reopened?.units).toEqual(replacement.projection.units)
          expect(reopened?.executionCheckpoints).toEqual(replacement.checkpoints.toSorted(compareExecutionCheckpoints))
          expect(reopened?.projectionVersion).toBe(projectionVersion)
        }).pipe(provideLayer(sqliteLayer(filename))),
      )
    }),
  ).pipe(provideLayer(BunServices.layer)),
)
