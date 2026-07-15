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

describe("memory thread summaries", () => {
  it.effect("orders recent activity and derives status, unread state, and edit totals", () =>
    Effect.gen(function* () {
      const threads = yield* ThreadRepository.Service
      const turns = yield* TurnRepository.Service
      const summaries = yield* ThreadSummaryRepository.Service
      yield* threads.create({ id: threadId, workspace: "/work", title: "First", now: 1 })
      const turn = yield* turns.createForSubmission({ id: turnId, threadId, prompt: "edit", now: 2 })
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
      const turn = yield* turns.createForSubmission({ id: turnId, threadId, prompt: "edit", now: 2 })
      expect((yield* summaries.list())[0]?.editTotals).toBeUndefined()
      expect(yield* summaries.listRepairCandidates()).toMatchObject([{ turnId, threadId }])
      yield* summaries.ensureTurn(turn.id, turn.threadId, 2)
      yield* turns.setStatus(turn.id, "completed", "cursor-2", 3)
      expect(yield* summaries.listRepairCandidates()).toMatchObject([{ turnId, lastCursor: "cursor-2" }])
    }).pipe(provideLayer(layer)),
  )
})
