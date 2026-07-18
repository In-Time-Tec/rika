import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import * as ThreadRepository from "../src/thread-repository"
import * as Thread from "../src/thread-schema"
import * as ThreadSummaryRepository from "../src/thread-summary-repository"
import * as TurnRepository from "../src/turn-repository"
import * as Turn from "../src/turn-schema"

const provideLayer =
  <ROut, E2, RIn>(layer: Layer.Layer<ROut, E2, RIn>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R | ROut>) =>
    Effect.gen(function* () {
      const context = yield* Layer.build(layer)
      return yield* effect.pipe(Effect.provide(context))
    })

const threadId = Thread.ThreadId.make("thread-a")
const turnId = Turn.TurnId.make("turn-a")
const repositories = Layer.merge(ThreadRepository.memoryLayer(), TurnRepository.memoryLayer())
const layer = Layer.merge(repositories, ThreadSummaryRepository.memoryLayer.pipe(Layer.provide(repositories)))

const create = (
  repository: TurnRepository.Interface,
  input: Omit<TurnRepository.CreateInput, "executionRoute" | "queueCapacity">,
) => repository.createForSubmission({ ...input, executionRoute: Turn.testExecutionRoute(), queueCapacity: 128 })

describe("memory thread summaries", () => {
  it.effect("orders recent activity and derives status, unread state, and edit totals", () =>
    Effect.gen(function* () {
      const threads = yield* ThreadRepository.Service
      const turns = yield* TurnRepository.Service
      const summaries = yield* ThreadSummaryRepository.Service
      yield* threads.create({ id: threadId, workspace: "/work", title: "First", now: 1 })
      const turn = yield* create(turns, { id: turnId, threadId, prompt: "edit", now: 2 })
      yield* summaries.ensureTurn(turn.id, turn.threadId, 2)
      expect(yield* summaries.list()).toMatchObject([
        { id: threadId, status: "running", unread: true, editTotals: { added: 0, modified: 0, removed: 0 } },
      ])
      yield* turns.setStatus(turn.id, "completed", "cursor-1", 3)
      yield* summaries.replaceTurn({
        turnId: turn.id,
        threadId,
        projectedCursor: "cursor-1",
        complete: true,
        editTotals: { added: 4, modified: 2, removed: 1 },
        lastEventAt: 4,
        now: 4,
      })
      expect(yield* summaries.list()).toMatchObject([
        {
          id: threadId,
          status: "idle",
          unread: true,
          lastActivityAt: 4,
          editTotals: { added: 4, modified: 2, removed: 1 },
        },
      ])
      yield* summaries.markRead(threadId, 5)
      expect((yield* summaries.list())[0]?.unread).toBe(false)
      expect(yield* summaries.listRepairCandidates()).toEqual([])
    }).pipe(provideLayer(layer)),
  )

  it.effect("omits partial totals and reports missing or stale projection work", () =>
    Effect.gen(function* () {
      const threads = yield* ThreadRepository.Service
      const turns = yield* TurnRepository.Service
      const summaries = yield* ThreadSummaryRepository.Service
      yield* threads.create({ id: threadId, workspace: "/work", title: "First", now: 1 })
      const turn = yield* create(turns, { id: turnId, threadId, prompt: "edit", now: 2 })
      expect((yield* summaries.list())[0]?.editTotals).toBeUndefined()
      expect(yield* summaries.listRepairCandidates()).toMatchObject([{ turnId, threadId }])
      yield* summaries.ensureTurn(turn.id, turn.threadId, 100)
      expect((yield* summaries.list())[0]?.lastActivityAt).toBe(2)
      yield* turns.setStatus(turn.id, "completed", "cursor-2", 3)
      expect(yield* summaries.listRepairCandidates()).toMatchObject([{ turnId, lastCursor: "cursor-2" }])
      expect((yield* summaries.list())[0]?.editTotals).toBeUndefined()
      yield* summaries.replaceTurn({
        turnId,
        threadId,
        projectedCursor: "cursor-2",
        complete: false,
        editTotals: { added: 99, modified: 99, removed: 99 },
        lastEventAt: 4,
        now: 101,
      })
      expect((yield* summaries.list())[0]?.editTotals).toBeUndefined()
      expect(yield* summaries.listRepairCandidates()).toMatchObject([{ turnId, lastCursor: "cursor-2" }])
      yield* summaries.replaceTurn({
        turnId,
        threadId,
        projectedCursor: "cursor-2",
        complete: true,
        editTotals: { added: 2, modified: 1, removed: 3 },
        lastEventAt: 5,
        now: 102,
      })
      expect((yield* summaries.list())[0]?.editTotals).toEqual({ added: 2, modified: 1, removed: 3 })
      expect(yield* summaries.listRepairCandidates()).toEqual([])
    }).pipe(provideLayer(layer)),
  )

  it.effect("keeps read watermarks monotonic across racing selections", () =>
    Effect.gen(function* () {
      const threads = yield* ThreadRepository.Service
      const summaries = yield* ThreadSummaryRepository.Service
      yield* threads.create({ id: threadId, workspace: "/work", title: "First", now: 1 })
      yield* summaries.markRead(threadId, 10)
      yield* summaries.markRead(threadId, 5)
      expect((yield* summaries.list())[0]).toMatchObject({ unread: false, lastActivityAt: 1 })
    }).pipe(provideLayer(layer)),
  )

  it.effect("orders pins before activity without treating pin or archive metadata as activity", () =>
    Effect.gen(function* () {
      const threads = yield* ThreadRepository.Service
      const summaries = yield* ThreadSummaryRepository.Service
      const older = Thread.ThreadId.make("older")
      const newer = Thread.ThreadId.make("newer")
      yield* threads.create({ id: older, workspace: "/work", title: "Older", now: 1 })
      yield* threads.create({ id: newer, workspace: "/work", title: "Newer", now: 2 })
      yield* summaries.markRead(older, 50)
      yield* summaries.markRead(newer, 50)
      yield* threads.setPinned(older, true, 100)
      expect(yield* summaries.list()).toMatchObject([
        { id: older, pinned: true, unread: false, lastActivityAt: 1 },
        { id: newer, pinned: false, unread: false, lastActivityAt: 2 },
      ])
      yield* threads.setPinned(older, false, 101)
      expect((yield* summaries.list()).map(({ id }) => id)).toEqual([newer, older])
      yield* threads.setArchived(newer, true, 102)
      expect((yield* summaries.list()).map(({ id }) => id)).toEqual([older])
      expect(yield* summaries.list({ includeArchived: true })).toMatchObject([
        { id: newer, archived: true, unread: false, lastActivityAt: 2 },
        { id: older, archived: false, unread: false, lastActivityAt: 1 },
      ])
    }).pipe(provideLayer(layer)),
  )

  it.effect("derives the highest live status and applies deterministic bounds", () =>
    Effect.gen(function* () {
      const threads = yield* ThreadRepository.Service
      const turns = yield* TurnRepository.Service
      const summaries = yield* ThreadSummaryRepository.Service
      yield* threads.create({ id: threadId, workspace: "/work", title: "First", now: 1 })
      const running = yield* create(turns, {
        id: Turn.TurnId.make("running"),
        threadId,
        prompt: "running",
        now: 2,
      })
      expect((yield* summaries.list())[0]?.status).toBe("running")
      const queued = yield* create(turns, {
        id: Turn.TurnId.make("queued"),
        threadId,
        prompt: "queued",
        now: 3,
      })
      expect(queued.status).toBe("queued")
      expect(yield* summaries.list({ limit: 0 })).toHaveLength(1)
      expect((yield* summaries.list())[0]?.status).toBe("running")
      yield* turns.setStatus(running.id, "completed", undefined, 4)
      expect((yield* summaries.list())[0]?.status).toBe("queued")
      const claimed = yield* turns.claimNextQueued(threadId, 5)
      if (claimed === undefined) return yield* Effect.die("queued turn was not claimed")
      yield* turns.finishQueuedClaim(claimed, "running", undefined, undefined, 5)
      expect((yield* summaries.list())[0]?.status).toBe("running")
      yield* turns.setStatus(claimed.turn.id, "waiting", undefined, 6)
      expect((yield* summaries.list())[0]?.status).toBe("waiting")
      yield* turns.setStatus(claimed.turn.id, "completed", undefined, 7)
      expect((yield* summaries.list())[0]?.status).toBe("idle")
    }).pipe(provideLayer(layer)),
  )

  it.effect("does not let an older activity projection overwrite newer state", () =>
    Effect.gen(function* () {
      const threads = yield* ThreadRepository.Service
      const turns = yield* TurnRepository.Service
      const summaries = yield* ThreadSummaryRepository.Service
      yield* threads.create({ id: threadId, workspace: "/work", title: "First", now: 1 })
      const turn = yield* create(turns, { id: turnId, threadId, prompt: "edit", now: 2 })
      yield* turns.setStatus(turn.id, "running", "newer", 2)
      yield* summaries.replaceTurn({
        turnId: turn.id,
        threadId,
        projectedCursor: "newer",
        complete: true,
        editTotals: { added: 5, modified: 4, removed: 3 },
        lastEventAt: 10,
        now: 10,
      })
      yield* summaries.replaceTurn({
        turnId: turn.id,
        threadId,
        projectedCursor: "older",
        complete: false,
        editTotals: { added: 1, modified: 0, removed: 0 },
        lastEventAt: 3,
        now: 3,
      })
      expect(yield* summaries.list()).toMatchObject([
        { lastActivityAt: 10, editTotals: { added: 5, modified: 4, removed: 3 } },
      ])
    }).pipe(provideLayer(layer)),
  )
})
