import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Schema } from "effect"
import { provideLayer } from "../../support/product-layer"
import { InteractiveEventSchema } from "../../../src/operation/interactive/event"
import * as RuntimeFeedOverflow from "../../../src/operation/interactive/view/feed"
import { GoalService, layer as goalServiceLayer } from "../../../src/thread/goal/service"
import * as GoalRepository from "../../../src/thread/repository/goal"

const goalService = goalServiceLayer.pipe(Layer.provide(GoalRepository.memoryLayer))

const goalChanged = {
  _tag: "GoalChanged" as const,
  threadId: "thread-a",
  goal: { objective: "ship the kernel", status: "active" as const, startedAtMillis: 1_000 },
}

describe("the Goal indicator is fed live server state", () => {
  it("encodes and decodes over the interactive wire", () => {
    const decoded = Schema.decodeSync(InteractiveEventSchema)(
      Schema.encodeSync(InteractiveEventSchema)(goalChanged),
    )
    expect(decoded).toEqual(goalChanged)
  })

  it("carries the cleared goal as an absent field rather than a sentinel", () => {
    const cleared = { _tag: "GoalChanged" as const, threadId: "thread-a" }
    const decoded = Schema.decodeSync(InteractiveEventSchema)(Schema.encodeSync(InteractiveEventSchema)(cleared))
    expect(decoded).toEqual(cleared)
    expect("goal" in decoded).toBe(false)
  })

  it("is critical, so goal state is never silently dropped under feed backpressure", () => {
    expect(RuntimeFeedOverflow.isCritical(goalChanged)).toBe(true)
  })

  it.effect("reports the goal a Thread actually has, and nothing for a Thread without one", () =>
    Effect.gen(function* () {
      const goals = yield* GoalService
      yield* goals.create({ threadId: "thread-a", objective: "ship the kernel", budget: {} })
      const active = yield* goals.get("thread-a")
      expect(active?.status).toBe("active")
      expect(yield* goals.get("thread-b")).toBeUndefined()
    }).pipe(provideLayer(goalService)),
  )

  it.effect("only an explicit completion ends a goal, so the indicator cannot clear itself", () =>
    Effect.gen(function* () {
      const goals = yield* GoalService
      yield* goals.create({ threadId: "thread-a", objective: "ship the kernel", budget: { tokens: 10 } })
      yield* goals.recordTurn({ threadId: "thread-a", tokens: 999, elapsedMillis: 1 })
      // An exhausted budget pauses; it never completes.
      expect((yield* goals.get("thread-a"))?.status).toBe("paused")
      yield* goals.complete({ threadId: "thread-a" })
      expect((yield* goals.get("thread-a"))?.status).toBe("complete")
    }).pipe(provideLayer(goalService)),
  )
})
