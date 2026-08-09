import * as BunServices from "@effect/platform-bun/BunServices"
import { expect, it } from "@effect/vitest"
import { Context, Effect, FileSystem, Layer } from "effect"
import { TestClock } from "effect/testing"
import * as GoalRepository from "@rika/product/goal-repository"
import { GoalService, layer as goalServiceLayer } from "@rika/product/goal-service"
import * as ThreadRepository from "../src/thread/sqlite-thread-repository"
import * as Thread from "@rika/product/thread-record"
import { layer as databaseLayer } from "../src/database/product-database-layer"
import { layer as sqliteGoalLayer } from "../src/goal/sqlite-goal-repository"

const threadId = Thread.ThreadId.make("thread-a")

const stack = (filename: string) =>
  Layer.mergeAll(goalServiceLayer, ThreadRepository.layer).pipe(
    Layer.provideMerge(sqliteGoalLayer),
    Layer.provideMerge(databaseLayer(filename)),
  )

/** One Rika data root opened twice: the second open is the Server restart under test. */
type Reopen = Effect.Effect<GoalService["Service"], never, never>

const withDatabase = <A, E>(use: (reopen: Reopen) => Effect.Effect<A, E, GoalService>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-goal-" })
      const open = Effect.gen(function* () {
        const context = yield* Layer.build(stack(`${directory}/rika.db`))
        const threads = Context.get(context, ThreadRepository.Service)
        yield* Effect.ignore(threads.create({ id: threadId, workspace: "/work", title: "Goals", now: 1 }))
        return Context.get(context, GoalService)
      }) as unknown as Reopen
      const first = yield* open
      return yield* Effect.provideService(use(open), GoalService, first)
    }),
  )

it.layer(BunServices.layer)("durable goal state", (test) => {
  test.effect("survives a Server restart with its objective, budget, and usage intact", () =>
    withDatabase((reopen) =>
      Effect.gen(function* () {
        const goals = yield* GoalService
        yield* goals.create({ threadId, objective: "land R4", budget: { tokens: 500 } })
        yield* goals.recordTurn({ threadId, tokens: 120, elapsedMillis: 4_000 })
        const reopened = yield* reopen
        expect(yield* reopened.get(threadId)).toMatchObject({
          objective: "land R4",
          status: "active",
          budget: { tokens: 500 },
          usage: { tokens: 120, elapsedMillis: 4_000, turns: 1 },
        })
      }),
    ),
  )

  test.effect("keeps a completed goal completed across a restart, with its summary", () =>
    withDatabase((reopen) =>
      Effect.gen(function* () {
        const goals = yield* GoalService
        yield* goals.create({ threadId, objective: "ship", budget: {} })
        yield* goals.complete({ threadId, summary: "shipped" })
        const reopened = yield* reopen
        expect(yield* reopened.get(threadId)).toMatchObject({ status: "complete", summary: "shipped" })
      }),
    ),
  )

  test.effect("refuses a second active goal on a Thread that already owns one, across a restart", () =>
    withDatabase((reopen) =>
      Effect.gen(function* () {
        const goals = yield* GoalService
        yield* goals.create({ threadId, objective: "first", budget: {} })
        const reopened = yield* reopen
        const conflict = yield* Effect.result(reopened.create({ threadId, objective: "second", budget: {} }))
        expect(conflict._tag).toBe("Failure")
        if (conflict._tag === "Failure") expect(conflict.failure._tag).toBe("GoalAlreadyActive")
        expect(yield* reopened.get(threadId)).toMatchObject({ objective: "first" })
      }),
    ),
  )

  test.effect("lets a new goal replace a completed one on the same Thread", () =>
    withDatabase(() =>
      Effect.gen(function* () {
        const goals = yield* GoalService
        yield* goals.create({ threadId, objective: "first", budget: {} })
        yield* goals.complete({ threadId })
        const second = yield* goals.create({ threadId, objective: "second", budget: {} })
        expect(second).toMatchObject({ objective: "second", status: "active", usage: { turns: 0 } })
        expect(second.completedAtMillis).toBeUndefined()
      }),
    ),
  )

  test.effect("pauses at the wall-clock budget durably and never completes itself", () =>
    withDatabase((reopen) =>
      Effect.gen(function* () {
        const goals = yield* GoalService
        yield* goals.create({ threadId, objective: "bounded", budget: { wallClockMillis: 1_000 } })
        yield* goals.recordTurn({ threadId, tokens: 0, elapsedMillis: 1_500 })
        const reopened = yield* reopen
        const paused = yield* reopened.get(threadId)
        expect(paused).toMatchObject({ status: "paused" })
        expect(paused?.completedAtMillis).toBeUndefined()
        expect(yield* reopened.continuation(threadId)).toBeUndefined()
      }),
    ),
  )

  test.effect("stops accounting once a goal is no longer active", () =>
    withDatabase(() =>
      Effect.gen(function* () {
        const goals = yield* GoalService
        yield* goals.create({ threadId, objective: "done", budget: {} })
        yield* goals.complete({ threadId })
        expect(yield* goals.recordTurn({ threadId, tokens: 99, elapsedMillis: 99 })).toBeUndefined()
        expect(yield* goals.get(threadId)).toMatchObject({ usage: { tokens: 0, turns: 0 } })
      }),
    ),
  )

  test.effect("continues prompting across Turns until the agent completes the goal", () =>
    withDatabase((reopen) =>
      Effect.gen(function* () {
        const goals = yield* GoalService
        yield* goals.create({ threadId, objective: "finish the migration", budget: {} })
        yield* goals.recordTurn({ threadId, tokens: 10, elapsedMillis: 10 })
        yield* goals.recordTurn({ threadId, tokens: 10, elapsedMillis: 10 })
        const reopened = yield* reopen
        expect(yield* reopened.continuation(threadId)).toContain("finish the migration")
        yield* reopened.complete({ threadId })
        expect(yield* reopened.continuation(threadId)).toBeUndefined()
      }),
    ),
  )

  test.effect("records elapsed wall clock from the clock rather than a stored counter", () =>
    withDatabase(() =>
      Effect.gen(function* () {
        const goals = yield* GoalService
        const created = yield* goals.create({ threadId, objective: "timed", budget: {} })
        yield* TestClock.adjust("2 minutes")
        const completed = yield* goals.complete({ threadId })
        expect(completed.completedAtMillis! - created.startedAtMillis).toBe(120_000)
      }),
    ),
  )

  test.effect("reports a missing goal as absent rather than failing", () =>
    withDatabase(() =>
      Effect.gen(function* () {
        const goals = yield* GoalService
        expect(yield* goals.get(threadId)).toBeUndefined()
        const complete = yield* Effect.result(goals.complete({ threadId }))
        expect(complete._tag).toBe("Failure")
        if (complete._tag === "Failure") expect(complete.failure._tag).toBe("GoalNotActive")
      }),
    ),
  )
})

it.layer(GoalRepository.memoryLayer)("goal repository parity", (test) => {
  test.effect("claims an in-memory row exactly once while it stays active", () =>
    Effect.gen(function* () {
      const goals = yield* GoalRepository.Service
      const row = {
        threadId: "thread",
        objective: "o",
        status: "active" as const,
        budget: {},
        usage: { tokens: 0, elapsedMillis: 0, turns: 0 },
        startedAtMillis: 0,
        updatedAtMillis: 0,
      }
      expect(yield* goals.claim(row)).toMatchObject({ objective: "o" })
      expect(yield* goals.claim({ ...row, objective: "second" })).toBeUndefined()
      yield* goals.replace({ ...row, status: "complete", completedAtMillis: 1 })
      expect(yield* goals.claim({ ...row, objective: "third" })).toMatchObject({ objective: "third" })
    }),
  )
})
