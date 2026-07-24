import { describe, expect, it } from "@effect/vitest"
import type * as ExecutionBackend from "@rika/runtime/contract"
import { BackendError } from "@rika/runtime/contract"
import { Duration, Effect } from "effect"
import * as UsageCost from "../src/usage-cost"

const usage = (cursor: string, costUsd: number): ExecutionBackend.Event => ({
  id: cursor,
  executionId: "execution",
  cursor,
  sequence: 0,
  type: "model.attempt.completed",
  createdAt: 1,
  data: {
    model_call_id: `call-${cursor}`,
    model_attempt_id: `attempt-${cursor}`,
    attempt: 1,
    cost: { amount: costUsd, currency: "USD" },
  },
})

const reportedTokens = (
  cursor: string,
  model: string,
  inputTokens: number | null,
  outputTokens: number | null,
  data: Readonly<Record<string, unknown>> = {},
): ExecutionBackend.Event => ({
  id: cursor,
  executionId: "execution",
  cursor,
  sequence: 0,
  type: "model.usage.reported",
  createdAt: 1,
  data: {
    model_call_id: `call-${cursor}`,
    model_attempt_id: `attempt-${cursor}`,
    attempt: 1,
    provider: "openai",
    model,
    input_tokens: inputTokens,
    input_tokens_uncached: inputTokens,
    input_tokens_cache_read: 0,
    input_tokens_cache_write: 0,
    output_tokens: outputTokens,
    ...data,
  },
})

const lifecycle = (
  executionId: string,
  id: string,
  type:
    | "execution.accepted"
    | "execution.started"
    | "wait.created"
    | "execution.completed"
    | "execution.failed"
    | "execution.cancelled",
  createdAt: number,
  sequence: number,
): ExecutionBackend.Event => ({
  id,
  executionId,
  cursor: id,
  sequence,
  type,
  createdAt,
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
  pageEvents: (executionId, _direction, cursor, limit = 1_000) => {
    const events = executions[executionId]?.events ?? []
    const start = cursor === undefined ? 0 : events.findIndex((event) => event.cursor === cursor) + 1
    const page = events.slice(start, start + limit)
    return Effect.succeed({
      events: page,
      hasMore: start + page.length < events.length,
      ...(page.at(-1) === undefined ? {} : { newestCursor: page.at(-1)!.cursor }),
    })
  },
})

describe("UsageCost", () => {
  it("keeps accepted and never-started cancelled executions at zero active time", () => {
    const accepted = UsageCost.observe(UsageCost.empty, {
      threadId: "thread",
      turnId: "turn",
      event: lifecycle("execution", "accepted", "execution.accepted", 1_000, 1),
    })
    const cancelled = UsageCost.observe(accepted, {
      threadId: "thread",
      turnId: "turn",
      event: lifecycle("execution", "cancelled", "execution.cancelled", 2_000, 2),
    })

    expect(UsageCost.activeTime(accepted, "thread")).toEqual({
      _tag: "Available",
      accumulated: Duration.zero,
    })
    expect(UsageCost.activeTime(cancelled, "thread")).toEqual({
      _tag: "Available",
      accumulated: Duration.zero,
    })
  })

  it("starts an accepted execution when the live started event arrives", () => {
    const accepted = UsageCost.observe(UsageCost.empty, {
      threadId: "thread",
      turnId: "turn",
      event: lifecycle("execution", "accepted", "execution.accepted", 1_000, 1),
    })
    const started = UsageCost.observe(accepted, {
      threadId: "thread",
      turnId: "turn",
      event: lifecycle("execution", "started", "execution.started", 2_000, 2),
    })

    expect(UsageCost.activeTime(started, "thread")).toEqual({
      _tag: "Available",
      accumulated: Duration.zero,
      activeSince: 2_000,
    })
  })

  it("accumulates execution work across durable waits and resumes", () => {
    const snapshot = [
      lifecycle("execution", "start-1", "execution.started", 1_000, 1),
      lifecycle("execution", "wait", "wait.created", 11_000, 2),
      lifecycle("execution", "start-2", "execution.started", 15_000, 3),
      lifecycle("execution", "complete", "execution.completed", 20_000, 4),
    ].reduce(
      (current, event) => UsageCost.observe(current, { threadId: "thread", turnId: "turn", event }),
      UsageCost.empty,
    )

    expect(UsageCost.activeTime(snapshot, "thread")).toEqual({
      _tag: "Available",
      accumulated: Duration.seconds(15),
    })
  })

  it("reconstructs open work deterministically from duplicate and out-of-order delivery", () => {
    const started = lifecycle("execution", "start", "execution.started", 5_000, 1)
    const waited = lifecycle("execution", "wait", "wait.created", 10_000, 2)
    const resumed = lifecycle("execution", "resume", "execution.started", 12_000, 3)
    const snapshot = [resumed, waited, started, resumed].reduce(
      (current, event) => UsageCost.observe(current, { threadId: "thread", turnId: "turn", event }),
      UsageCost.empty,
    )

    expect(UsageCost.activeTime(snapshot, "thread")).toEqual({
      _tag: "Available",
      accumulated: Duration.seconds(5),
      activeSince: 12_000,
    })
  })

  it.effect("unions overlapping parent and child intervals instead of adding parallel work", () =>
    Effect.gen(function* () {
      const snapshot = yield* UsageCost.collect(
        reader({
          parent: {
            events: [
              lifecycle("parent", "parent-start", "execution.started", 0, 1),
              lifecycle("parent", "parent-wait", "wait.created", 10_000, 2),
            ],
            children: ["child"],
          },
          child: {
            events: [
              lifecycle("child", "child-start", "execution.started", 5_000, 1),
              lifecycle("child", "child-complete", "execution.completed", 15_000, 2),
            ],
          },
        }),
        [{ threadId: "thread", turnId: "parent" }],
      )

      expect(UsageCost.activeTime(snapshot, "thread")).toEqual({
        _tag: "Available",
        accumulated: Duration.seconds(15),
      })
    }),
  )

  it.effect("reconstructs the same active time when a persisted execution tree is reopened", () =>
    Effect.gen(function* () {
      const executions = {
        parent: {
          events: [
            lifecycle("parent", "start", "execution.started", 1_000, 1),
            lifecycle("parent", "wait", "wait.created", 11_000, 2),
          ],
        },
      }
      const roots = [{ threadId: "thread", turnId: "parent" }]
      const beforeClose = yield* UsageCost.collect(reader(executions), roots)
      const afterReopen = yield* UsageCost.collect(reader(executions), roots)

      expect(UsageCost.activeTime(afterReopen, "thread")).toEqual(UsageCost.activeTime(beforeClose, "thread"))
      expect(UsageCost.activeTime(afterReopen, "thread")).toEqual({
        _tag: "Available",
        accumulated: Duration.seconds(10),
      })
    }),
  )

  it("makes active time unavailable when lifecycle identity or timestamps are invalid", () => {
    const missingIdentity = UsageCost.observe(UsageCost.empty, {
      threadId: "thread",
      turnId: "turn",
      event: { cursor: "start", sequence: 1, type: "execution.started", createdAt: 1 },
    })
    const invalidTimestamp = UsageCost.observe(UsageCost.empty, {
      threadId: "thread",
      turnId: "turn",
      event: lifecycle("execution", "start", "execution.started", -1, 1),
    })

    expect(UsageCost.activeTime(missingIdentity, "thread")).toEqual({ _tag: "Unavailable" })
    expect(UsageCost.activeTime(invalidTimestamp, "thread")).toEqual({ _tag: "Unavailable" })
  })

  it("uses durable sequence order and rejects regressing lifecycle timestamps", () => {
    const snapshot = [
      lifecycle("execution", "start", "execution.started", 10_000, 1),
      lifecycle("execution", "wait", "wait.created", 5_000, 2),
    ].reduce(
      (current, event) => UsageCost.observe(current, { threadId: "thread", turnId: "turn", event }),
      UsageCost.empty,
    )

    expect(UsageCost.activeTime(snapshot, "thread")).toEqual({ _tag: "Unavailable" })
  })

  it.effect("reads every lifecycle page beyond Relay replay's bounded window", () =>
    Effect.gen(function* () {
      const events: Array<ExecutionBackend.Event> = [
        lifecycle("execution", "accepted", "execution.accepted", 0, 0),
        lifecycle("execution", "started", "execution.started", 1_000, 1),
        ...Array.from({ length: 1_001 }, (_, index) => ({
          id: `output-${index}`,
          executionId: "execution",
          cursor: `output-${index}`,
          sequence: index + 2,
          type: "model.output.delta",
          createdAt: 1_001 + index,
        })),
        lifecycle("execution", "completed", "execution.completed", 11_000, 1_003),
      ]
      const complete = reader({ execution: { events } })
      const snapshot = yield* UsageCost.collect(
        {
          ...complete,
          replay: () => Effect.succeed({ turnId: "execution", status: "running", events: events.slice(0, 1_000) }),
        },
        [{ threadId: "thread", turnId: "execution" }],
      )

      expect(UsageCost.activeTime(snapshot, "thread")).toEqual({
        _tag: "Available",
        accumulated: Duration.seconds(10),
      })
    }),
  )

  it("prices uncached input, cache reads, and output from the models.dev snapshot", () => {
    expect(
      UsageCost.eventCostUsd(
        reportedTokens("cached", "gpt-5.6-sol", 10_000, 100, {
          input_tokens_uncached: 1_000,
          input_tokens_cache_read: 9_000,
          input_tokens_cache_write: 0,
        }),
      ),
    ).toBeCloseTo(0.0125, 10)
    expect(
      UsageCost.eventCostUsd(
        reportedTokens("cache-write", "gpt-5.6-sol", 100, 0, {
          input_tokens_uncached: 0,
          input_tokens_cache_read: 0,
          input_tokens_cache_write: 100,
        }),
      ),
    ).toBeCloseTo(0.000625, 10)
  })

  it("uses the provider-returned model snapshot and falls back to the configured model", () => {
    expect(
      UsageCost.eventCostUsd(
        reportedTokens("snapshot", "gpt-5.6-luna", 100_000, 0, {
          model_snapshot: "gpt-5.6-sol",
          input_tokens_uncached: 100_000,
        }),
      ),
    ).toBe(0.5)
    expect(
      UsageCost.eventCostUsd(
        reportedTokens("fallback", "gpt-5.6-luna", 100_000, 0, {
          model_snapshot: "unknown",
          input_tokens_uncached: 100_000,
        }),
      ),
    ).toBe(0.1)
  })

  it("selects provider pricing modes from reported service metadata", () => {
    expect(
      UsageCost.eventCostUsd(
        reportedTokens("priority", "gpt-5.6-sol", 1_000_000, 1_000_000, {
          service_tier: "priority",
          input_tokens_uncached: 1_000_000,
        }),
      ),
    ).toBe(70)
    expect(
      UsageCost.eventCostUsd(
        reportedTokens("unknown-tier", "gpt-5.6-sol", 1_000_000, 0, {
          service_tier: "flex",
          input_tokens_uncached: 1_000_000,
        }),
      ),
    ).toBeUndefined()
  })

  it("does not derive missing uncached input from other buckets", () => {
    expect(
      UsageCost.eventCostUsd(
        reportedTokens("derived", "gpt-5.6-terra", 200_000, 0, {
          input_tokens_uncached: null,
          input_tokens_cache_read: 180_000,
          input_tokens_cache_write: 0,
        }),
      ),
    ).toBeUndefined()
    expect(
      UsageCost.eventCostUsd(
        reportedTokens("missing-total", "gpt-5.6-sol", null, 0, {
          input_tokens_uncached: 100_000,
          input_tokens_cache_read: 100_000,
          input_tokens_cache_write: 0,
        }),
      ),
    ).toBeUndefined()
  })

  it("accepts a null zero cache-write bucket but requires complete token accounting", () => {
    expect(
      UsageCost.eventCostUsd(
        reportedTokens("missing-output", "gpt-5.6-sol", 100, null, {
          input_tokens_uncached: 100,
        }),
      ),
    ).toBeUndefined()
    expect(
      UsageCost.eventCostUsd(
        reportedTokens("missing-cache-write", "gpt-5.6-sol", 100, 0, {
          input_tokens_cache_write: null,
        }),
      ),
    ).toBe(0.0005)
    expect(
      UsageCost.eventCostUsd(
        reportedTokens("unaccounted-cache-write", "gpt-5.6-sol", 100, 0, {
          input_tokens_uncached: 50,
          input_tokens_cache_write: null,
        }),
      ),
    ).toBeUndefined()
    expect(
      UsageCost.eventCostUsd(
        reportedTokens("reasoning-subset", "gpt-5.6-sol", 0, 100, {
          input_tokens_uncached: 0,
          output_tokens_reasoning: 50,
        }),
      ),
    ).toBe(0.003)
  })

  it("leaves missing and malformed reports unpriced", () => {
    expect(UsageCost.eventCostUsd(reportedTokens("missing", "test", null, null))).toBeUndefined()
    expect(UsageCost.eventCostUsd(reportedTokens("unknown-model", "unknown", 1_000, 1_000))).toBeUndefined()
    expect(
      UsageCost.eventCostUsd(
        reportedTokens("inconsistent", "gpt-5.6-sol", 100, 0, {
          input_tokens_uncached: 80,
          input_tokens_cache_read: 30,
          input_tokens_cache_write: 0,
        }),
      ),
    ).toBeUndefined()
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

  it("totals input and output once while ignoring reasoning and input breakdowns", () => {
    const event = reportedTokens("tokens", "gpt-5.6-sol", 30_000_000, 10_100_000, {
      input_tokens_uncached: 5_000_000,
      input_tokens_cache_read: 20_000_000,
      input_tokens_cache_write: 5_000_000,
      output_tokens_reasoning: 8_000_000,
    })
    const snapshot = UsageCost.observe(UsageCost.empty, { threadId: "thread", turnId: "turn", event })

    expect(snapshot.threadTokens.get("thread")).toBe(40_100_000)
    expect(snapshot.tokenCompleteThreads.has("thread")).toBe(true)
  })

  it("keeps token and provider-cost completeness independent", () => {
    const provider = usage("provider", 2)
    const missingBreakdown = reportedTokens("tokens", "unknown", 10, 5, {
      model_attempt_id: provider.data?.model_attempt_id,
      input_tokens_uncached: null,
    })
    const snapshot = [provider, missingBreakdown].reduce(
      (current, event) => UsageCost.observe(current, { threadId: "thread", turnId: "turn", event }),
      UsageCost.empty,
    )

    expect(snapshot.threadCostUsd.get("thread")).toBe(2)
    expect(snapshot.costCompleteThreads.has("thread")).toBe(true)
    expect(snapshot.threadTokens.get("thread")).toBe(15)
    expect(snapshot.tokenCompleteThreads.has("thread")).toBe(true)
  })

  it("marks tokens unavailable when the exact input total is missing", () => {
    const snapshot = UsageCost.observe(UsageCost.empty, {
      threadId: "thread",
      turnId: "turn",
      event: reportedTokens("tokens", "gpt-5.6-sol", null, 5, {
        input_tokens_uncached: 10,
        input_tokens_cache_read: 20,
      }),
    })

    expect(snapshot.tokenCompleteThreads.has("thread")).toBe(false)
  })

  it("requires released identity and attempt fields only for cost-bearing events", () => {
    const unrelated = UsageCost.observe(UsageCost.empty, {
      threadId: "thread",
      turnId: "turn",
      event: { cursor: "output", sequence: 0, type: "model.output.completed", createdAt: 1 },
    })
    const { id: _, ...eventWithoutId } = usage("missing-identity", 1)
    const missingIdentity = UsageCost.observe(unrelated, {
      threadId: "thread",
      turnId: "turn",
      event: eventWithoutId,
    })
    const missingAttempt = UsageCost.observe(UsageCost.empty, {
      threadId: "thread",
      turnId: "turn",
      event: { ...usage("missing-attempt", 1), data: {} },
    })

    expect(unrelated).toBe(UsageCost.empty)
    expect(missingIdentity.complete).toBe(false)
    expect(missingAttempt.complete).toBe(false)
  })

  it("replaces an attempt estimate with provider USD cost in either arrival order", () => {
    const report = reportedTokens("report", "gpt-5.6-sol", 10_000, 100, {
      model_attempt_id: "shared-attempt",
      input_tokens_uncached: 1_000,
      input_tokens_cache_read: 9_000,
    })
    const completed = {
      ...usage("completed", 2.5),
      data: { ...usage("completed", 2.5).data, model_attempt_id: "shared-attempt" },
    }
    for (const events of [
      [report, completed],
      [completed, report],
    ]) {
      const snapshot = events.reduce(
        (current, event) => UsageCost.observe(current, { threadId: "thread", turnId: "turn", event }),
        UsageCost.empty,
      )
      expect(snapshot.globalCostUsd).toBe(2.5)
      expect(snapshot.complete).toBe(true)
    }
  })

  it.each([
    ["non-USD", { amount: 2, currency: "EUR" }],
    ["malformed", { amount: "2", currency: "USD" }],
    ["negative", { amount: -2, currency: "USD" }],
  ])("makes cost unknown for present %s provider cost", (_, cost) => {
    const report = reportedTokens("report", "gpt-5.6-sol", 1_000, 0, { model_attempt_id: "attempt" })
    const completed = {
      ...usage("completed", 0),
      data: { ...usage("completed", 0).data, model_attempt_id: "attempt", cost },
    }
    const estimated = UsageCost.observe(UsageCost.empty, { threadId: "thread", turnId: "turn", event: report })
    const snapshot = UsageCost.observe(estimated, { threadId: "thread", turnId: "turn", event: completed })

    expect(snapshot.globalCostUsd).toBe(0)
    expect(snapshot.complete).toBe(false)
  })

  it("keeps an estimate when completed provider cost is absent", () => {
    const report = reportedTokens("report", "gpt-5.6-sol", 10_000, 100, {
      model_attempt_id: "attempt",
      input_tokens_uncached: 1_000,
      input_tokens_cache_read: 9_000,
    })
    const completed = {
      ...usage("completed", 0),
      data: { model_call_id: "call", model_attempt_id: "attempt", attempt: 1 },
    }
    const snapshot = [completed, report].reduce(
      (current, event) => UsageCost.observe(current, { threadId: "thread", turnId: "turn", event }),
      UsageCost.empty,
    )

    expect(snapshot.globalCostUsd).toBeCloseTo(0.0125, 10)
    expect(snapshot.complete).toBe(true)
  })

  it("does not estimate nested completed usage and marks partial totals incomplete", () => {
    const nested = {
      ...usage("nested", 0),
      data: {
        model_call_id: "nested-call",
        model_attempt_id: "nested-attempt",
        attempt: 1,
        usage: { provider: "openai", model: "gpt-5.6-sol", input_tokens: 1_000, output_tokens: 0 },
      },
    }
    const snapshot = [usage("priced", 1), nested].reduce(
      (current, event) => UsageCost.observe(current, { threadId: "thread", turnId: "turn", event }),
      UsageCost.empty,
    )

    expect(snapshot.globalCostUsd).toBe(1)
    expect(snapshot.complete).toBe(false)
  })

  it("deduplicates values by attempt and deliveries by execution and event id", () => {
    const first = usage("first", 1)
    const sameAttempt = {
      ...usage("second", 9),
      data: { ...usage("second", 9).data, model_attempt_id: first.data?.model_attempt_id },
    }
    const duplicateDelivery = { ...usage("ignored", 8), id: "first" }
    const snapshot = [first, sameAttempt, duplicateDelivery].reduce(
      (current, event) => UsageCost.observe(current, { threadId: "thread", turnId: "turn", event }),
      UsageCost.empty,
    )

    expect(snapshot.globalCostUsd).toBe(0)
    expect(snapshot.complete).toBe(false)
  })

  it("scopes reused event and attempt ids to their execution", () => {
    const first = { ...usage("same", 1), executionId: "execution-a" }
    const second = { ...usage("same", 2), executionId: "execution-b" }
    const snapshot = [first, second].reduce(
      (current, event) => UsageCost.observe(current, { threadId: "thread", turnId: "turn", event }),
      UsageCost.empty,
    )

    expect(snapshot.globalCostUsd).toBe(3)
  })

  it("does not require dense or arrival-ordered execution sequences", () => {
    const later = { ...usage("later", 2), sequence: 100 }
    const earlier = { ...usage("earlier", 1), sequence: 3 }
    const snapshot = [later, earlier].reduce(
      (current, event) => UsageCost.observe(current, { threadId: "thread", turnId: "turn", event }),
      UsageCost.empty,
    )

    expect(snapshot.globalCostUsd).toBe(3)
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
      expect(snapshot.costCompleteThreads.has("thread-a")).toBe(false)
      expect(snapshot.tokenCompleteThreads.has("thread-a")).toBe(false)
      expect(snapshot.costCompleteThreads.has("thread-b")).toBe(true)
      expect(snapshot.tokenCompleteThreads.has("thread-b")).toBe(false)
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
