import { expect, test } from "vitest"
import * as BunServices from "@effect/platform-bun/BunServices"
import * as TranscriptCorrelation from "@rika/transcript/child-parent-correlation"
import * as TranscriptProjection from "@rika/transcript/transcript-projection"
import { Effect, FileSystem, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import * as Database from "@rika/product-store/product-database-layer"
import * as ThreadRepository from "@rika/product-store/sqlite-thread-repository"
import * as ThreadSummaryRepository from "@rika/product-store/sqlite-thread-summary-repository"
import * as TurnRepository from "../src/turn/sqlite-turn-repository"
import * as TranscriptRepository from "../src/transcript/sqlite-transcript-repository"
import * as Turn from "@rika/product/turn-record"
import { id, create, provideLayer } from "./sqlite-queue-support"
import { commitAll } from "./transcript-repository-fixtures"

test("thread creation rolls back its workspace when the thread insert fails", () => {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-thread-atomicity-" })
      const database = Database.layer(`${directory}/rika.db`)
      const layer = Layer.merge(database, ThreadRepository.layer.pipe(Layer.provide(database)))
      yield* Effect.gen(function* () {
        const threads = yield* ThreadRepository.Service
        const sql = yield* SqlClient
        yield* sql`CREATE TRIGGER reject_thread BEFORE INSERT ON rika_threads
          BEGIN SELECT RAISE(ABORT, 'injected thread failure'); END`
        const result = yield* Effect.result(
          threads.create({ id, workspace: "/work/rollback", title: "Rejected", now: 1 }),
        )
        expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "ThreadRepositoryError" } })
        expect(yield* sql`SELECT path FROM rika_workspaces WHERE path = '/work/rollback'`).toEqual([])
        expect(yield* threads.get(id)).toBeUndefined()
      }).pipe(provideLayer(layer))
    }),
  )
  return Effect.runPromise(Effect.scoped(program.pipe(provideLayer(BunServices.layer))))
})

test("malformed SQLite product rows fail through typed repositories", () => {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-malformed-rows-" })
      const database = Database.layer(`${directory}/rika.db`)
      const layer = Layer.mergeAll(
        database,
        ThreadRepository.layer.pipe(Layer.provide(database)),
        TurnRepository.layer.pipe(Layer.provide(database)),
        TranscriptRepository.layer.pipe(Layer.provide(database)),
      )
      yield* Effect.gen(function* () {
        const threads = yield* ThreadRepository.Service
        const turns = yield* TurnRepository.Service
        const transcripts = yield* TranscriptRepository.Service
        const sql = yield* SqlClient
        yield* threads.create({ id, workspace: "/work", title: "Malformed", now: 1 })
        const turn = yield* create(turns, {
          id: Turn.TurnId.make("malformed-turn"),
          threadId: id,
          prompt: "persist",
          now: 2,
        })
        yield* commitAll(transcripts, turn, TranscriptProjection.Projection.empty(turn.id, turn.prompt), undefined)
        yield* sql`UPDATE rika_threads SET labels_json = 'not-json' WHERE id = ${id}`
        expect(yield* Effect.result(threads.get(id))).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "ThreadRepositoryError" },
        })
        yield* sql`INSERT INTO rika_transcript_units
          (turn_id, unit_key, execution_key, thread_id, unit_order_key, revision, unit_json, created_at, updated_at)
          VALUES (${turn.id}, 'malformed-unit', ${TranscriptCorrelation.executionKey(turn.id)}, ${id}, 'malformed-order', 1, 'not-json', 2, 2)`
        expect(yield* Effect.result(transcripts.get(turn.id))).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "TranscriptRepositoryError" },
        })
      }).pipe(provideLayer(layer))
    }),
  )
  return Effect.runPromise(Effect.scoped(program.pipe(provideLayer(BunServices.layer))))
})

test("independent SQLite clients share queue limits and reject stale summary writes", () => {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-concurrent-clients-" })
      const filename = `${directory}/rika.db`
      const makeLayer = () => {
        const database = Database.layer(filename)
        return Layer.mergeAll(
          database,
          ThreadRepository.layer.pipe(Layer.provide(database)),
          TurnRepository.layer.pipe(Layer.provide(database)),
          ThreadSummaryRepository.layer.pipe(Layer.provide(database)),
        )
      }
      const first = yield* Layer.build(makeLayer())
      const second = yield* Layer.build(makeLayer())
      const [threads, firstTurns, firstSummaries, firstSql] = yield* Effect.all([
        ThreadRepository.Service,
        TurnRepository.Service,
        ThreadSummaryRepository.Service,
        SqlClient,
      ]).pipe(Effect.provide(first))
      const [secondTurns, secondSummaries] = yield* Effect.all([
        TurnRepository.Service,
        ThreadSummaryRepository.Service,
      ]).pipe(Effect.provide(second))
      yield* threads.create({ id, workspace: "/work", title: "Concurrent", now: 1 })
      const active = yield* create(firstTurns, {
        id: Turn.TurnId.make("client-active"),
        threadId: id,
        prompt: "active",
        queueCapacity: 2,
        now: 2,
      })
      const attempts = yield* Effect.forEach(
        Array.from({ length: 6 }, (_, index) => index),
        (index) =>
          Effect.result(
            create(index % 2 === 0 ? firstTurns : secondTurns, {
              id: Turn.TurnId.make(`client-queued-${index}`),
              threadId: id,
              prompt: `queued ${index}`,
              queueCapacity: 2,
              now: index + 3,
            }),
          ),
        { concurrency: "unbounded" },
      )
      expect(attempts.filter((attempt) => attempt._tag === "Success")).toHaveLength(2)
      expect(attempts.filter((attempt) => attempt._tag === "Failure").map((attempt) => attempt.failure)).toEqual(
        Array.from({ length: 4 }, () =>
          expect.objectContaining({ _tag: "TurnQueueFull", threadId: id, capacity: 2, count: 2 }),
        ),
      )
      expect(yield* firstTurns.readQueue(id)).toMatchObject({ queuedCount: 2, revision: 2 })
      yield* firstSummaries.replaceTurn({
        turnId: active.id,
        threadId: id,
        projectedCursor: "newer",
        complete: true,
        editTotals: { added: 8, modified: 5, removed: 3 },
        lastEventAt: 20,
        now: 20,
      })
      yield* secondSummaries.replaceTurn({
        turnId: active.id,
        threadId: id,
        projectedCursor: "older",
        complete: false,
        editTotals: { added: 1, modified: 0, removed: 0 },
        lastEventAt: 4,
        now: 4,
      })
      expect(yield* secondSummaries.list()).toMatchObject([{ lastActivityAt: 20 }])
      expect(
        yield* firstSql`SELECT projected_cursor, complete, added, modified, removed, updated_at
        FROM rika_thread_turn_activity WHERE turn_id = ${active.id}`,
      ).toEqual([{ projected_cursor: "newer", complete: 1, added: 8, modified: 5, removed: 3, updated_at: 20 }])
    }),
  )
  return Effect.runPromise(Effect.scoped(program.pipe(provideLayer(BunServices.layer))))
})
