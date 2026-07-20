import { describe, expect, it } from "@effect/vitest"
import type * as ExecutionBackend from "@rika/runtime/contract"
import { BackendError } from "@rika/runtime/contract"
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
  it("estimates cost from reported tokens when no monetary usage exists", () => {
    expect(UsageCost.eventCostUsd(reportedTokens("haiku", "claude-3-5-haiku-latest", 1_000_000, 1_000_000))).toBe(4.8)
    expect(UsageCost.eventCostUsd(reportedTokens("opus", "claude-opus-4-1", 1_000_000, 1_000_000))).toBe(30)
    expect(UsageCost.eventCostUsd(reportedTokens("partial", "gpt-5-mini", null, 1_000_000))).toBe(4)
    expect(UsageCost.eventCostUsd(reportedTokens("early-budget", "gpt-5", 500_000, 0))).toBe(0.625)
  })

  it("leaves missing and malformed reports unpriced", () => {
    expect(UsageCost.eventCostUsd(reportedTokens("missing", "test", null, null))).toBeUndefined()
    expect(UsageCost.eventCostUsd(usage("negative", -10))).toBeUndefined()
  })

  it("accepts only explicit event-local USD aliases", () => {
    expect(UsageCost.eventCostUsd(usage("snake", 1.25))).toBe(1.25)
    expect(UsageCost.eventCostUsd({ ...usage("camel", 0), data: { costUsd: 2.5 } })).toBe(2.5)
  })

  it.each([
    ["generic cost", { cost: 1 }],
    ["generic usd", { usd: 1 }],
    ["nested usage cost", { usage: { cost: 1 } }],
    ["cumulative total", { total_cost_usd: 1 }],
  ])("rejects %s as event-local monetary usage", (_, data) => {
    expect(UsageCost.eventCostUsd({ ...usage("rejected", 0), data })).toBeUndefined()
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

  it.effect("keeps other execution costs when one execution fails to read", () =>
    Effect.gen(function* () {
      const healthy = reader({
        "turn-a": { events: [usage("usage-a", 1.5)], children: ["child-a"] },
        "child-a": { events: [usage("usage-child-a", 0.5)] },
        "turn-b": { events: [usage("usage-b", 3)] },
      })
      const snapshot = yield* UsageCost.collect(
        {
          inspect: healthy.inspect,
          replay: (executionId) =>
            executionId === "child-a"
              ? Effect.fail(BackendError.make({ message: "replay failed" }))
              : healthy.replay(executionId),
        },
        [
          { threadId: "thread-a", turnId: "turn-a" },
          { threadId: "thread-b", turnId: "turn-b" },
        ],
      )

      expect(snapshot.turnCostUsd.get("turn-a")).toBe(1.5)
      expect(snapshot.threadCostUsd.get("thread-b")).toBe(3)
      expect(snapshot.globalCostUsd).toBe(4.5)
    }),
  )

  it.effect("only records turns and threads with observed usage", () =>
    Effect.gen(function* () {
      const snapshot = yield* UsageCost.collect(
        reader({
          "turn-a": { events: [usage("usage-a", 2)] },
          "turn-b": { events: [] },
        }),
        [
          { threadId: "thread-a", turnId: "turn-a" },
          { threadId: "thread-b", turnId: "turn-b" },
        ],
      )

      expect(snapshot.turnCostUsd.has("turn-b")).toBe(false)
      expect(snapshot.threadCostUsd.has("thread-b")).toBe(false)
      expect(snapshot.turnCostUsd.get("turn-a")).toBe(2)
    }),
  )
})
