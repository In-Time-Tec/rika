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

const reportedTokens = (
  cursor: string,
  model: string,
  inputTokens: number | null,
  outputTokens: number | null,
): ExecutionBackend.Event => ({
  cursor,
  sequence: 0,
  type: "model.usage.reported",
  createdAt: 1,
  data: { model, input_tokens: inputTokens, output_tokens: outputTokens },
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
  it("converts Relay token reports without pricing Haiku as full-size Claude", () => {
    expect(UsageCost.eventCostUsd(reportedTokens("haiku", "claude-3-5-haiku-latest", 1_000_000, 1_000_000))).toBe(4.8)
    expect(UsageCost.eventCostUsd(reportedTokens("opus", "claude-opus-4-1", 1_000_000, 1_000_000))).toBe(30)
    expect(UsageCost.eventCostUsd(reportedTokens("partial", "gpt-5-mini", null, 1_000_000))).toBe(4)
  })

  it("leaves missing and malformed reports unpriced", () => {
    expect(UsageCost.eventCostUsd(reportedTokens("missing", "test", null, null))).toBeUndefined()
    expect(UsageCost.eventCostUsd(usage("negative", -10))).toBeUndefined()
  })

  it("counts a durable usage cursor only once across replay and live recovery", () => {
    const event = usage("durable-usage", 2.5)
    const replayed = UsageCost.observe(UsageCost.empty, { threadId: "thread", turnId: "turn", event })
    const recovered = UsageCost.observe(replayed, { threadId: "thread", turnId: "turn", event })

    expect(recovered).toBe(replayed)
    expect(recovered.turnCostUsd.get("turn")).toBe(2.5)
    expect(recovered.threadCostUsd.get("thread")).toBe(2.5)
    expect(recovered.globalCostUsd).toBe(2.5)
  })

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

  it.effect("keeps thread totals separate while bounding collection to the supplied global roots", () =>
    Effect.gen(function* () {
      const executions = Object.fromEntries(
        Array.from({ length: 101 }, (_, index) => [`turn-${index}`, { events: [usage(`usage-${index}`, 1)] }]),
      )
      const roots = Array.from({ length: 100 }, (_, index) => ({
        threadId: `thread-${index}`,
        turnId: `turn-${index}`,
      }))
      const snapshot = yield* UsageCost.collect(reader(executions), roots)

      expect(UsageCost.maximumGlobalThreads).toBe(100)
      expect(snapshot.threadCostUsd).toHaveLength(100)
      expect(snapshot.threadCostUsd.get("thread-0")).toBe(1)
      expect(snapshot.threadCostUsd.has("thread-100")).toBe(false)
      expect(snapshot.globalCostUsd).toBe(100)
    }),
  )

  it.effect("includes every Turn in a Thread total", () =>
    Effect.gen(function* () {
      const executions = Object.fromEntries(
        Array.from({ length: 201 }, (_, index) => [`turn-${index}`, { events: [usage(`usage-${index}`, 1)] }]),
      )
      const roots = Array.from({ length: 201 }, (_, index) => ({ threadId: "thread", turnId: `turn-${index}` }))
      const snapshot = yield* UsageCost.collect(reader(executions), roots)

      expect(snapshot.turnCostUsd).toHaveLength(201)
      expect(snapshot.threadCostUsd.get("thread")).toBe(201)
      expect(snapshot.globalCostUsd).toBe(201)
    }),
  )

  it.effect("charges a separately durable title execution to its first Turn", () =>
    Effect.gen(function* () {
      const snapshot = yield* UsageCost.collect(
        reader({
          "turn-first": { events: [usage("turn-usage", 2)] },
          "title:turn-first": { events: [usage("title-usage", 0.25)] },
        }),
        [
          { threadId: "thread-a", turnId: "turn-first" },
          { threadId: "thread-a", turnId: "turn-first", executionId: "title:turn-first" },
        ],
      )

      expect(snapshot.turnCostUsd.get("turn-first")).toBe(2.25)
      expect(snapshot.threadCostUsd.get("thread-a")).toBe(2.25)
      expect(snapshot.globalCostUsd).toBe(2.25)
    }),
  )
})
