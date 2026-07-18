import { describe, expect, it } from "@effect/vitest"
import type * as ExecutionBackend from "@rika/runtime/contract"
import { Effect } from "effect"
import * as UsageCost from "../src/usage-cost"

const usage = (cursor: string, costUsd: number): ExecutionBackend.Event => ({
  cursor,
  sequence: 0,
  type: "model.usage.reported",
  createdAt: 1,
  data: { cost_usd: costUsd },
})

const reader = (
  executions: Readonly<
    Record<
      string,
      { readonly events: ReadonlyArray<ExecutionBackend.Event>; readonly children?: ReadonlyArray<string> }
    >
  >,
): UsageCost.ExecutionReader => ({
  inspect: (executionId) => {
    const execution = executions[executionId]
    return Effect.succeed(
      execution === undefined
        ? undefined
        : {
            turnId: executionId,
            status: "completed" as const,
            waits: [],
            pendingTools: [],
            children: (execution.children ?? []).map((child) => ({ executionId: child, status: "completed" as const })),
          },
    )
  },
  replay: (executionId) => {
    const execution = executions[executionId]
    return Effect.succeed({
      turnId: executionId,
      status: "completed" as const,
      events: execution?.events ?? [],
    })
  },
})

describe("UsageCost", () => {
  it.effect("rolls two children and a grandchild into the parent turn and thread total", () =>
    Effect.gen(function* () {
      const snapshot = yield* UsageCost.collect(
        reader({
          parent: { events: [usage("parent-usage", 1)], children: ["child-a", "child-b"] },
          "child-a": { events: [usage("child-a-usage", 2)], children: ["grandchild"] },
          "child-b": { events: [usage("child-b-usage", 3)] },
          grandchild: { events: [usage("grandchild-usage", 4)] },
        }),
        [{ threadId: "thread-a", turnId: "parent" }],
      )

      expect(snapshot.turnCostUsd.get("parent")).toBe(10)
      expect(snapshot.threadCostUsd.get("thread-a")).toBe(10)
      expect(snapshot.globalCostUsd).toBe(10)
    }),
  )

  it.effect("adds execution trees across threads into one global total", () =>
    Effect.gen(function* () {
      const snapshot = yield* UsageCost.collect(
        reader({
          "turn-a": { events: [usage("usage-a", 1.25)], children: ["child-a"] },
          "child-a": { events: [usage("usage-child-a", 0.75)] },
          "turn-b": { events: [usage("usage-b", 3.5)] },
        }),
        [
          { threadId: "thread-a", turnId: "turn-a" },
          { threadId: "thread-b", turnId: "turn-b" },
        ],
      )

      expect(snapshot.threadCostUsd.get("thread-a")).toBe(2)
      expect(snapshot.threadCostUsd.get("thread-b")).toBe(3.5)
      expect(snapshot.globalCostUsd).toBe(5.5)
    }),
  )
})
