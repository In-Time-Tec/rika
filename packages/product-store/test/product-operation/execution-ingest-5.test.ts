import { describe, expect, it } from "@effect/vitest"
import {
  Deferred,
  Effect,
  Ref,
  TestClock,
  ExecutionIngest,
  threadId,
  rootId,
  checkpoint,
  event,
  started,
  makeHarness,
  settle,
} from "./execution-ingest-behavior-support"

describe("ExecutionIngest", () => {
  it.effect("coalesces a burst of events into one commit per debounce window", () =>
    Effect.gen(function* () {
      const burst = [
        event("root", "b1", 1, "model.output.completed", { text: "one" }),
        event("root", "b2", 2, "model.output.completed", { text: "two" }),
        event("root", "b3", 3, "model.output.completed", { text: "three" }),
      ]
      const { ingest, transcripts, commits } = yield* makeHarness({
        script: {},
        turnStatus: "running",
        commitEvents: 64,
      })

      yield* ingest.ensure({ threadId, turnId: rootId })
      yield* ingest.consumed(rootId)
      const caughtUp = commits.length

      for (const delivered of burst) ingest.deliver(rootId, delivered)
      for (let attempt = 0; attempt < 50; attempt += 1) yield* Effect.yieldNow
      expect(commits).toHaveLength(caughtUp)

      yield* TestClock.adjust(ExecutionIngest.defaultCommitWindow)
      for (let attempt = 0; attempt < 50; attempt += 1) yield* Effect.yieldNow

      expect(commits).toHaveLength(caughtUp + 1)
      expect(checkpoint(yield* transcripts.get(rootId), "root")).toEqual(
        expect.objectContaining({ cursor: "b3", sequence: 3 }),
      )
    }),
  )

  it.effect("flushes events accepted after the initial durable prefix", () =>
    Effect.gen(function* () {
      const { ingest, transcripts } = yield* makeHarness({
        script: { root: { events: [], status: "running" } },
        turnStatus: "running",
      })

      yield* ingest.ensure({ threadId, turnId: rootId })
      yield* ingest.consumed(rootId)
      ingest.deliver(rootId, event("root", "late", 1, "model.output.completed", { text: "late answer" }))
      yield* ingest.flush(rootId)

      const stored = yield* transcripts.get(rootId)
      expect(checkpoint(stored, "root")).toEqual(expect.objectContaining({ cursor: "late", sequence: 1 }))
      expect(
        stored?.units.some(
          (unit) =>
            unit.content._tag === "Entry" && unit.content.role === "assistant" && unit.content.text === "late answer",
        ),
      ).toBe(true)
    }),
  )

  it.effect("flushes owner events delivered while the initial backend page is still loading", () =>
    Effect.gen(function* () {
      const pageOpen = yield* Deferred.make<void>()
      const first = event("root", "prefix", 1, "model.output.completed", { text: "durable prefix" })
      const late = event("root", "late", 2, "model.output.completed", { text: "owner delivery" })
      const { ingest, transcripts } = yield* makeHarness({
        script: {
          root: {
            events: [first],
            status: "running",
            pages: (after) =>
              after === undefined
                ? { events: [first], hasMore: true, newestCursor: first.cursor }
                : { events: [], hasMore: false, newestCursor: first.cursor },
          },
        },
        turnStatus: "running",
        pageHold: { after: first.cursor, open: pageOpen },
      })

      yield* ingest.ensure({ threadId, turnId: rootId })
      ingest.deliver(rootId, late)
      const flushed = yield* Deferred.make<void>()
      yield* Effect.forkChild(ingest.flush(rootId).pipe(Effect.andThen(Deferred.succeed(flushed, undefined))))
      for (let attempt = 0; attempt < 50; attempt += 1) yield* Effect.yieldNow

      expect(yield* Deferred.isDone(flushed)).toBe(false)
      yield* Deferred.succeed(pageOpen, undefined)
      yield* Deferred.await(flushed)

      expect(checkpoint(yield* transcripts.get(rootId), "root")).toEqual(
        expect.objectContaining({ cursor: "late", sequence: 2 }),
      )
    }),
  )

  it.effect("flushes exactly the accepted version while a repository write is suspended", () =>
    Effect.gen(function* () {
      const writeStarted = yield* Deferred.make<void>()
      const writeOpen = yield* Deferred.make<void>()
      const { ingest, transcripts } = yield* makeHarness({
        script: { root: { events: [], status: "running" } },
        turnStatus: "running",
        commitGate: (write) =>
          write === 2
            ? Deferred.succeed(writeStarted, undefined).pipe(Effect.andThen(Deferred.await(writeOpen)))
            : Effect.void,
      })

      yield* ingest.ensure({ threadId, turnId: rootId })
      yield* ingest.consumed(rootId)
      ingest.deliver(rootId, event("root", "first", 1, "model.output.completed", { text: "first" }))
      const firstFlushed = yield* Deferred.make<void>()
      yield* Effect.forkChild(ingest.flush(rootId).pipe(Effect.andThen(Deferred.succeed(firstFlushed, undefined))))
      for (let attempt = 0; attempt < 2_000 && !(yield* Deferred.isDone(writeStarted)); attempt += 1)
        yield* Effect.yieldNow
      expect(yield* Deferred.isDone(writeStarted)).toBe(true)
      yield* Deferred.await(writeStarted)

      ingest.deliver(rootId, event("root", "second", 2, "model.output.completed", { text: "second" }))
      yield* Deferred.succeed(writeOpen, undefined)
      for (let attempt = 0; attempt < 2_000 && !(yield* Deferred.isDone(firstFlushed)); attempt += 1)
        yield* Effect.yieldNow
      expect(yield* Deferred.isDone(firstFlushed)).toBe(true)
      yield* Deferred.await(firstFlushed)

      expect(checkpoint(yield* transcripts.get(rootId), "root")).toEqual(
        expect.objectContaining({ cursor: "first", sequence: 1 }),
      )
      const secondFlushed = yield* Deferred.make<void>()
      yield* Effect.forkChild(ingest.flush(rootId).pipe(Effect.andThen(Deferred.succeed(secondFlushed, undefined))))
      for (let attempt = 0; attempt < 2_000 && !(yield* Deferred.isDone(secondFlushed)); attempt += 1)
        yield* Effect.yieldNow
      expect(yield* Deferred.isDone(secondFlushed)).toBe(true)
      yield* Deferred.await(secondFlushed)
      expect(checkpoint(yield* transcripts.get(rootId), "root")).toEqual(
        expect.objectContaining({ cursor: "second", sequence: 2 }),
      )
    }),
  )

  it.effect("persists an event accepted while cancellation waits on its final repository write", () =>
    Effect.gen(function* () {
      const writeStarted = yield* Deferred.make<void>()
      const writeOpen = yield* Deferred.make<void>()
      const { ingest, transcripts, turns } = yield* makeHarness({
        script: { root: { events: [], status: "running" } },
        turnStatus: "running",
        commitGate: (write) =>
          write === 2
            ? Deferred.succeed(writeStarted, undefined).pipe(Effect.andThen(Deferred.await(writeOpen)))
            : Effect.void,
      })

      yield* ingest.ensure({ threadId, turnId: rootId })
      yield* ingest.consumed(rootId)
      ingest.deliver(rootId, started("root"))
      ingest.deliver(rootId, event("root", "answer", 1, "model.output.completed", { text: "before cancel" }))
      yield* turns.setStatus(rootId, "cancelled", "cancelled", 2)
      yield* ingest.ensure({ threadId, turnId: rootId })
      for (let attempt = 0; attempt < 2_000 && !(yield* Deferred.isDone(writeStarted)); attempt += 1)
        yield* Effect.yieldNow
      expect(yield* Deferred.isDone(writeStarted)).toBe(true)

      ingest.deliver(rootId, event("root", "cancelled", 2, "execution.cancelled"))
      yield* Deferred.succeed(writeOpen, undefined)
      yield* ingest.settled(rootId)

      const stored = yield* transcripts.get(rootId)
      expect(checkpoint(stored, "root")).toEqual(
        expect.objectContaining({ cursor: "cancelled", sequence: 2, status: "cancelled" }),
      )
      expect(stored?.units.find((unit) => unit.executionOutcome !== undefined)?.executionOutcome).toEqual({
        status: "cancelled",
      })
      yield* ingest.flush(rootId)
    }),
  )

  it.effect("fails every concurrent flush waiter when its repository write fails", () =>
    Effect.gen(function* () {
      const failures = yield* Ref.make(0)
      const writeStarted = yield* Deferred.make<void>()
      const writeOpen = yield* Deferred.make<void>()
      const { ingest } = yield* makeHarness({
        script: { root: { events: [], status: "running" } },
        turnStatus: "running",
        commitFailures: failures,
        commitGate: (write) =>
          write === 2
            ? Deferred.succeed(writeStarted, undefined).pipe(Effect.andThen(Deferred.await(writeOpen)))
            : Effect.void,
      })

      yield* ingest.ensure({ threadId, turnId: rootId })
      yield* ingest.consumed(rootId)
      ingest.deliver(rootId, event("root", "failing", 1, "model.output.completed", { text: "fail" }))
      const first = yield* Deferred.make<ExecutionIngest.Failure>()
      const second = yield* Deferred.make<ExecutionIngest.Failure>()
      yield* Effect.forkChild(
        Effect.flip(ingest.flush(rootId)).pipe(Effect.flatMap((failure) => Deferred.succeed(first, failure))),
      )
      yield* Deferred.await(writeStarted)
      yield* Effect.forkChild(
        Effect.flip(ingest.flush(rootId)).pipe(Effect.flatMap((failure) => Deferred.succeed(second, failure))),
      )
      for (let attempt = 0; attempt < 20; attempt += 1) yield* Effect.yieldNow
      yield* Ref.set(failures, 1)
      yield* Deferred.succeed(writeOpen, undefined)

      const firstFailure = yield* Deferred.await(first)
      const secondFailure = yield* Deferred.await(second)
      expect(firstFailure).toBe(secondFailure)
      expect(firstFailure.reason).toBe("repository")
    }),
  )

  it.effect("commits without waiting for the window once the batch size is reached", () =>
    Effect.gen(function* () {
      const hold = yield* Deferred.make<void>()
      const burst = [
        event("root", "b1", 1, "model.output.completed", { text: "one" }),
        event("root", "b2", 2, "model.output.completed", { text: "two" }),
      ]
      const { ingest, commits } = yield* makeHarness({
        script: { root: { events: burst, status: "running", hold } },
        turnStatus: "running",
        commitEvents: 2,
      })

      yield* ingest.ensure({ threadId, turnId: rootId })
      for (let attempt = 0; attempt < 50; attempt += 1) yield* Effect.yieldNow

      expect(commits).toHaveLength(1)
      yield* Deferred.succeed(hold, undefined)
    }),
  )

  it.effect("commits each projection delta with the latest persisted Turn", () =>
    Effect.gen(function* () {
      const { ingest, transcripts, turns } = yield* makeHarness({
        script: { root: { events: [], status: "running" } },
        turnStatus: "running",
      })

      yield* ingest.ensure({ threadId, turnId: rootId })
      yield* ingest.consumed(rootId)
      ingest.deliver(rootId, started("root"))
      yield* turns.setStatus(rootId, "running", "newer-turn-cursor", 2)
      ingest.deliver(rootId, event("root", "projection-cursor", 1, "model.output.completed", { text: "answer" }))
      yield* ingest.flush(rootId)

      expect(yield* transcripts.get(rootId)).toMatchObject({
        turn: { status: "running", lastCursor: "newer-turn-cursor", updatedAt: 2 },
      })

      yield* turns.setStatus(rootId, "completed", "done", 3)
      ingest.deliver(rootId, event("root", "done", 2, "execution.completed"))
      yield* settle(ingest)
    }),
  )
})
