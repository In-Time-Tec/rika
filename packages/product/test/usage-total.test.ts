import { describe, expect, it } from "@effect/vitest"
import { Result } from "effect"
import * as Support from "./usage-test-support"

describe("UsageCost", () => {
  it("scopes reused delivery cursors to their execution", () => {
    const sharedDelivery = (executionId: string, costUsd: number) => ({
      ...Support.Fixtures.usage("cursor-shared", costUsd),
      executionId,
      data: { ...Support.Fixtures.usage("cursor-shared", costUsd).data, model_attempt_id: `attempt-${executionId}` },
    })
    const first = sharedDelivery("execution-a", 1)
    const second = sharedDelivery("execution-b", 2)
    const snapshot = [first, second, first].reduce(
      (current, event) => Support.UsageCost.observe(current, { threadId: "thread", turnId: "turn", event }),
      Support.UsageCost.empty,
    )

    expect(snapshot.global.costUsd).toBe(3)
    expect(snapshot.global.pricedAttempts).toBe(2)
  })

  it("does not require dense or arrival-ordered execution sequences", () => {
    const later = { ...Support.Fixtures.usage("later", 2), sequence: 100 }
    const earlier = { ...Support.Fixtures.usage("earlier", 1), sequence: 3 }
    const snapshot = [later, earlier].reduce(
      (current, event) => Support.UsageCost.observe(current, { threadId: "thread", turnId: "turn", event }),
      Support.UsageCost.empty,
    )

    expect(snapshot.global.costUsd).toBe(3)
  })

  it("rolls two children and a grandchild into the parent turn and thread total", () => {
    const snapshot = Support.Fixtures.fold(
      [
        Support.Fixtures.usageIn("parent", "parent-usage", 1),
        Support.Fixtures.usageIn("child-a", "child-a-usage", 2),
        Support.Fixtures.usageIn("child-b", "child-b-usage", 3),
        Support.Fixtures.usageIn("grandchild", "grandchild-usage", 4),
      ],
      { threadId: "thread-a", turnId: "parent" },
    )

    expect(Support.UsageCost.turnTotals(snapshot, "parent").costUsd).toBe(10)
    expect(Support.UsageCost.threadTotals(snapshot, "thread-a").costUsd).toBe(10)
    expect(snapshot.global.costUsd).toBe(10)
  })

  it("adds execution trees across threads into one global total", () => {
    const threadA = Support.Fixtures.fold(
      [Support.Fixtures.usageIn("turn-a", "usage-a", 1.25), Support.Fixtures.usageIn("child-a", "usage-child-a", 0.75)],
      {
        threadId: "thread-a",
        turnId: "turn-a",
      },
    )
    const snapshot = Support.Fixtures.fold(
      [Support.Fixtures.usageIn("turn-b", "usage-b", 3.5)],
      { threadId: "thread-b", turnId: "turn-b" },
      threadA,
    )

    expect(Support.UsageCost.threadTotals(snapshot, "thread-a").costUsd).toBe(2)
    expect(Support.UsageCost.threadTotals(snapshot, "thread-b").costUsd).toBe(3.5)
    expect(snapshot.global.costUsd).toBe(5.5)
  })

  it("includes every Turn in a Thread total", () => {
    const snapshot = Array.from({ length: 201 }, (_, index) => index).reduce(
      (current, index) =>
        Support.Fixtures.fold(
          [Support.Fixtures.usageIn(`turn-${index}`, `usage-${index}`, 1)],
          { threadId: "thread", turnId: `turn-${index}` },
          current,
        ),
      Support.UsageCost.empty,
    )

    expect(snapshot.turns).toHaveLength(201)
    expect(Support.UsageCost.threadTotals(snapshot, "thread").costUsd).toBe(201)
    expect(snapshot.global.costUsd).toBe(201)
  })

  it("charges a separately durable title execution to its first Turn", () => {
    const snapshot = Support.Fixtures.fold(
      [
        Support.Fixtures.usageIn("turn-first", "turn-usage", 2),
        Support.Fixtures.usageIn("title:turn-first", "title-usage", 0.25),
      ],
      {
        threadId: "thread-a",
        turnId: "turn-first",
      },
    )

    expect(Support.UsageCost.turnTotals(snapshot, "turn-first").costUsd).toBe(2.25)
    expect(Support.UsageCost.threadTotals(snapshot, "thread-a").costUsd).toBe(2.25)
    expect(snapshot.global.costUsd).toBe(2.25)
  })

  it("only records turns and threads with observed usage", () => {
    const snapshot = Support.Fixtures.fold([Support.Fixtures.usageIn("turn-a", "usage-a", 2)], {
      threadId: "thread-a",
      turnId: "turn-a",
    })

    expect(snapshot.turns.has("turn-b")).toBe(false)
    expect(snapshot.threads.has("thread-b")).toBe(false)
    expect(Support.UsageCost.turnTotals(snapshot, "turn-a").costUsd).toBe(2)
  })

  it("folds incrementally through one working fold without per-event snapshot copies", () => {
    const usageFold = Support.RawUsageCost.restoreUsageFold(Support.RawUsageCost.empty)
    const events = [Support.Fixtures.usage("a", 1), Support.Fixtures.usage("b", 2), Support.Fixtures.usage("c", 3)]
    for (const event of events)
      Support.unwrap(Support.RawUsageCost.applyUsageFoldEvent(usageFold, { threadId: "thread", turnId: "turn", event }))
    const incremental = Support.RawUsageCost.snapshotUsageFold(usageFold)
    const batched = Support.RawUsageCost.foldBatch(
      Support.RawUsageCost.empty,
      events.map((event) => ({ threadId: "thread", turnId: "turn", event })),
    )
    expect(Result.isSuccess(batched)).toBe(true)
    if (Result.isFailure(batched)) return
    expect(incremental.global.costUsd).toBe(batched.success.global.costUsd)
    expect(incremental.attempts.size).toBe(batched.success.attempts.size)
    const replay = Support.RawUsageCost.observe(incremental, { threadId: "thread", turnId: "turn", event: events[0]! })
    expect(Result.isSuccess(replay) && replay.success).toBe(incremental)
  })
})
