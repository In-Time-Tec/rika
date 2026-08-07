import * as BunServices from "@effect/platform-bun/BunServices"
import * as ExecutionRouteSnapshot from "@rika/product/execution-route-snapshot"
import * as Thread from "@rika/product/thread-record"
import type * as TranscriptPage from "@rika/product/transcript-page"
import type * as TranscriptRepositoryContract from "@rika/product/transcript-repository"
import * as Turn from "@rika/product/turn-record"
import * as UnitOrder from "@rika/transcript/transcript-unit-order"
import { expect, test } from "vitest"
import { Effect, FileSystem, Layer } from "effect"
import { provideLayer } from "./sqlite-queue-support"
import * as Database from "@rika/product-store/product-database-layer"
import * as ThreadRepository from "@rika/product-store/sqlite-thread-repository"
import * as TranscriptRepository from "@rika/product-store/sqlite-transcript-repository"
import * as TurnRepository from "@rika/product-store/sqlite-turn-repository"

const threadId = Thread.ThreadId.make("transcript-pagination")
const turn = (id: string, createdAt: number): Turn.AgentExecutionTurn => ({
  _tag: "AgentExecution",
  id: Turn.TurnId.make(id),
  threadId,
  prompt: id,
  executionRoute: ExecutionRouteSnapshot.testExecutionRoute(),
  status: "completed",
  author: { _tag: "Human" },
  lineage: { _tag: "Original" },
  createdAt,
  updatedAt: createdAt,
})
const unit = (turnId: Turn.TurnId, prefix: string, index: number) => {
  const key = `${prefix}-${String(index).padStart(3, "0")}`
  return {
    key,
    turnId,
    order: UnitOrder.unitOrder(key, index),
    revision: index,
    content: { _tag: "Entry" as const, role: "assistant" as const, text: key },
  }
}
const olderTurn = turn("older", 1)
const newestTurn = turn("newest", 2)
const olderUnits = Array.from({ length: 5 }, (_, index) => unit(olderTurn.id, "older", index))
const newestUnits = Array.from({ length: 125 }, (_, index) => unit(newestTurn.id, "newest", index))
const keys = (page: TranscriptPage.Page) => page.entries.map((entry) => entry.unit.key)

const cursorFor = (entry: TranscriptPage.Entry): TranscriptPage.PageCursor => ({
  createdAt: entry.turn.createdAt,
  turnId: entry.turn.id,
  orderKey: UnitOrder.encodeUnitOrder(entry.unit.order),
})

const assertPaginationContract = (
  repository: TranscriptRepositoryContract.Interface,
): Effect.Effect<void, TranscriptRepositoryContract.RepositoryError, never> =>
  Effect.gen(function* () {
    yield* repository.replaceUnits(olderTurn, olderUnits)
    yield* repository.replaceUnits(newestTurn, newestUnits)

    const newest = yield* repository.page(threadId, { limit: 120 })
    expect(keys(newest)).toEqual(newestUnits.slice(5).map((value) => value.key))
    expect(newest).toMatchObject({ hasOlder: true, hasNewer: false })
    expect(newest.oldestCursor).toEqual(cursorFor(newest.entries[0]!))
    expect(newest.newestCursor).toEqual(cursorFor(newest.entries.at(-1)!))

    const older = yield* repository.page(threadId, { before: newest.oldestCursor, limit: 10 })
    expect(keys(older)).toEqual([...olderUnits, ...newestUnits.slice(0, 5)].map((value) => value.key))
    expect(older).toMatchObject({ hasOlder: false, hasNewer: true })
    expect(older.oldestCursor).toEqual(cursorFor(older.entries[0]!))
    expect(older.newestCursor).toEqual(cursorFor(older.entries.at(-1)!))

    const roundTrip = yield* repository.page(threadId, { after: older.newestCursor, limit: 120 })
    expect(keys(roundTrip)).toEqual(keys(newest))
    expect(new Set([...keys(older), ...keys(roundTrip)]).size).toBe(130)
    expect(roundTrip).toMatchObject({ hasOlder: true, hasNewer: false })
    expect(roundTrip.oldestCursor).toEqual(newest.oldestCursor)
    expect(roundTrip.newestCursor).toEqual(newest.newestCursor)

    const firstForward = yield* repository.page(threadId, { after: cursorFor(older.entries[4]!), limit: 50 })
    expect(keys(firstForward)).toEqual(newestUnits.slice(0, 50).map((value) => value.key))
    expect(firstForward).toMatchObject({ hasOlder: true, hasNewer: true })
    const back = yield* repository.page(threadId, { before: firstForward.oldestCursor, limit: 5 })
    expect(keys(back)).toEqual(olderUnits.map((value) => value.key))
    expect(back).toMatchObject({ hasOlder: false, hasNewer: true })
  })

test("memory transcript pages are contiguous and directionally reversible", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const repository = yield* TranscriptRepository.makeMemory()
      yield* assertPaginationContract(repository)
    }),
  ))

test("SQLite transcript pages are contiguous and directionally reversible", () => {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-transcript-pagination-" })
      const database = Database.layer(`${directory}/rika.db`)
      const layer = Layer.mergeAll(
        database,
        ThreadRepository.layer.pipe(Layer.provide(database)),
        TurnRepository.layer.pipe(Layer.provide(database)),
        TranscriptRepository.layer.pipe(Layer.provide(database)),
      )
      const context = yield* Layer.build(layer)
      const threads = yield* ThreadRepository.Service.pipe(Effect.provide(context))
      const turns = yield* TurnRepository.Service.pipe(Effect.provide(context))
      const transcripts = yield* TranscriptRepository.Service.pipe(Effect.provide(context))
      yield* threads.create({ id: threadId, workspace: "/workspace", title: "pagination", now: 0 })
      yield* turns.copy(olderTurn, 8)
      yield* turns.copy(newestTurn, 8)
      yield* assertPaginationContract(transcripts)
    }),
  )
  return Effect.runPromise(Effect.scoped(program.pipe(provideLayer(BunServices.layer))))
})
