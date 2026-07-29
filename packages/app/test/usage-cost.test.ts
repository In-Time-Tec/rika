import { describe, expect, it } from "@effect/vitest"
import type * as ExecutionBackend from "@rika/runtime/contract"
import { Duration } from "effect"
import * as UsageCost from "../src/usage-cost"

const usage = (cursor: string, costUsd: number): ExecutionBackend.Event => ({
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

const attemptCompleted = (cursor: string, attemptId: string, executionId = "execution"): ExecutionBackend.Event => ({
  executionId,
  cursor,
  sequence: 0,
  type: "model.attempt.completed",
  createdAt: 1,
  data: { model_call_id: `call-${cursor}`, model_attempt_id: attemptId, attempt: 1 },
})

const reportedTokens = (
  cursor: string,
  model: string,
  inputTokens: number | null,
  outputTokens: number | null,
  data: Readonly<Record<string, unknown>> = {},
): ExecutionBackend.Event => ({
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
    | "wait.woken"
    | "wait.timed_out"
    | "execution.completed"
    | "execution.failed"
    | "execution.cancelled",
  createdAt: number,
  sequence: number,
): ExecutionBackend.Event => ({ executionId, cursor: id, sequence, type, createdAt, timestampSource: "server" })

const unstampedLifecycle = (
  executionId: string,
  id: string,
  type: "execution.started" | "wait.created" | "wait.woken" | "execution.completed",
  createdAt: number,
  sequence: number,
): ExecutionBackend.Event => ({ executionId, cursor: id, sequence, type, createdAt })

const work = (executionId: string, cursor: string, type: string, createdAt: number, sequence: number) =>
  ({ executionId, cursor, sequence, type, createdAt }) as ExecutionBackend.Event

const usageIn = (executionId: string, cursor: string, costUsd: number): ExecutionBackend.Event => ({
  ...usage(cursor, costUsd),
  executionId,
})

const fold = (
  events: ReadonlyArray<ExecutionBackend.Event>,
  input: { readonly threadId: string; readonly turnId: string } = { threadId: "thread", turnId: "turn" },
  snapshot: UsageCost.Snapshot = UsageCost.empty,
): UsageCost.Snapshot => events.reduce((current, event) => UsageCost.observe(current, { ...input, event }), snapshot)

describe("UsageCost", () => {
  it("round trips every fold state and continues identically", () => {
    const input = { threadId: "thread", turnId: "turn" }
    const before = [
      lifecycle("execution", "accepted", "execution.accepted", 1_000, 1),
      lifecycle("execution", "started", "execution.started", 2_000, 2),
      usage("cost", 0.25),
    ].reduce((snapshot, event) => UsageCost.observe(snapshot, { ...input, event }), UsageCost.empty)
    const after = [
      reportedTokens("tokens", "gpt-4o", 10, 5),
      lifecycle("execution", "completed", "execution.completed", 5_000, 4),
    ]
    const uninterrupted = after.reduce((snapshot, event) => UsageCost.observe(snapshot, { ...input, event }), before)
    const resumed = after.reduce(
      (snapshot, event) => UsageCost.observe(snapshot, { ...input, event }),
      UsageCost.deserialize(UsageCost.serialize(before))!,
    )
    expect(UsageCost.serialize(resumed)).toBe(UsageCost.serialize(uninterrupted))
    expect(UsageCost.observe(resumed, { ...input, event: after[0]! })).toEqual(resumed)
  })

  it("treats an unknown fold version as absent and recomputes through refold", () => {
    const events = [
      lifecycle("execution", "start", "execution.started", 1_000, 1),
      usage("cost", 0.25),
      lifecycle("execution", "complete", "execution.completed", 11_000, 2),
    ]
    const current = fold(events)
    const unknown = JSON.stringify({ ...JSON.parse(UsageCost.serialize(current)), version: UsageCost.foldVersion - 1 })

    expect(UsageCost.deserialize(unknown)).toBeUndefined()
    const refolded = fold(events, { threadId: "thread", turnId: "turn" }, UsageCost.empty)
    expect(UsageCost.turnTotals(refolded, "turn").costUsd).toBe(0.25)
    expect(UsageCost.activeTime(refolded, "thread")).toEqual({
      _tag: "Available",
      accumulated: Duration.seconds(10),
    })
  })

  it("ignores transient delta events entirely", () => {
    const accepted = UsageCost.observe(UsageCost.empty, {
      threadId: "thread",
      turnId: "turn",
      event: lifecycle("execution", "accepted", "execution.accepted", 1_000, 1),
    })
    const next = UsageCost.observe(accepted, {
      threadId: "thread",
      turnId: "turn",
      event: {
        executionId: "execution",
        cursor: "delta-1",
        sequence: 1,
        type: "model.output.delta",
        createdAt: 2_000,
        data: { delta: "x", transient_index: 1 },
      },
    })

    expect(next).toBe(accepted)
  })

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

  it("closes an execution interval at its server-stamped terminal timestamp", () => {
    const snapshot = fold([
      lifecycle("execution", "start", "execution.started", 1_000, 1),
      work("execution", "output", "model.output.delta", 5_000, 2),
      lifecycle("execution", "complete", "execution.completed", 1_000, 3),
    ])

    expect(UsageCost.activeTime(snapshot, "thread")).toEqual({ _tag: "Available", accumulated: Duration.zero })
  })

  it("ignores model and tool timestamps when measuring active time", () => {
    const lifecycleOnly = fold([
      lifecycle("execution", "start", "execution.started", 1_000, 1),
      lifecycle("execution", "wait", "wait.created", 6_000, 4),
    ])
    const withWork = fold([
      lifecycle("execution", "start", "execution.started", 1_000, 1),
      work("execution", "tool", "tool.call.requested", 5_000, 2),
      work("execution", "output", "model.output.delta", 90_000, 3),
      lifecycle("execution", "wait", "wait.created", 6_000, 4),
    ])

    expect(UsageCost.isObservedEvent(work("execution", "tool", "tool.call.requested", 5_000, 2))).toBe(false)
    expect(UsageCost.activeTime(withWork, "thread")).toEqual(UsageCost.activeTime(lifecycleOnly, "thread"))
    expect(UsageCost.activeTime(withWork, "thread")).toEqual({
      _tag: "Available",
      accumulated: Duration.seconds(5),
    })
  })

  it("resumes active time from a durable wait timeout", () => {
    const snapshot = fold([
      lifecycle("execution", "start-1", "execution.started", 1_000, 1),
      lifecycle("execution", "wait", "wait.created", 2_000, 7),
      lifecycle("execution", "timeout", "wait.timed_out", 10_000, 12),
      lifecycle("execution", "complete", "execution.completed", 12_000, 14),
    ])

    expect(UsageCost.activeTime(snapshot, "thread")).toEqual({
      _tag: "Available",
      accumulated: Duration.seconds(3),
    })
  })

  it("resumes active time when Relay continues directly from a durable wake", () => {
    const snapshot = fold([
      lifecycle("execution", "start", "execution.started", 1_000, 1),
      lifecycle("execution", "wait", "wait.created", 2_000, 7),
      lifecycle("execution", "wake", "wait.woken", 10_000, 12),
      lifecycle("execution", "complete", "execution.completed", 12_000, 27),
    ])

    expect(UsageCost.activeTime(snapshot, "thread")).toEqual({
      _tag: "Available",
      accumulated: Duration.seconds(3),
    })
  })

  it("does not change the fold for appended streaming deltas", () => {
    const resumed = fold([
      lifecycle("execution", "start", "execution.started", 1_000, 1),
      lifecycle("execution", "wait", "wait.created", 2_000, 7),
      lifecycle("execution", "wake", "wait.woken", 10_000, 12),
    ])
    const streamed = fold(
      Array.from({ length: 2_000 }, (_, index) =>
        work("execution", `output-${index}`, "model.output.delta", 10_001 + index, 14 + index),
      ),
      { threadId: "thread", turnId: "turn" },
      resumed,
    )

    expect(streamed).toBe(resumed)
    expect(UsageCost.activeTime(streamed, "thread")).toEqual({
      _tag: "Available",
      accumulated: Duration.seconds(1),
      activeSince: 10_000,
    })
  })

  it("keeps one execution's time when another execution's lifecycle conflicts", () => {
    const snapshot = fold([
      lifecycle("healthy", "start", "execution.started", 1_000, 1),
      lifecycle("healthy", "complete", "execution.completed", 4_000, 2),
      lifecycle("conflicted", "start", "execution.started", 1_000, 1),
      { ...lifecycle("conflicted", "start", "execution.started", 9_000, 1) },
      lifecycle("conflicted", "complete", "execution.completed", 20_000, 2),
    ])

    expect(snapshot.malformedExecutions.has("conflicted")).toBe(true)
    expect(UsageCost.activeTime(snapshot, "thread")).toEqual({
      _tag: "Available",
      accumulated: Duration.seconds(3),
    })
  })

  it("orders lifecycle evidence by durable sequence instead of delivery order", () => {
    const events = [
      lifecycle("execution", "start-1", "execution.started", 1_000, 1),
      lifecycle("execution", "wait", "wait.created", 6_000, 2),
      lifecycle("execution", "wake", "wait.woken", 10_000, 3),
      lifecycle("execution", "complete", "execution.completed", 12_000, 5),
    ]
    const durable = fold(events)
    const live = fold([events[3]!, events[0]!, events[2]!, events[1]!])

    expect(UsageCost.activeTime(live, "thread")).toEqual(UsageCost.activeTime(durable, "thread"))
    expect(UsageCost.activeTime(live, "thread")).toEqual({
      _tag: "Available",
      accumulated: Duration.seconds(7),
    })
  })

  it("reconstructs open work deterministically from duplicate and out-of-order delivery", () => {
    const started = lifecycle("execution", "start", "execution.started", 5_000, 1)
    const waited = lifecycle("execution", "wait", "wait.created", 10_000, 2)
    const resumed = lifecycle("execution", "resume", "wait.woken", 12_000, 3)
    const snapshot = fold([resumed, waited, started, resumed])

    expect(UsageCost.activeTime(snapshot, "thread")).toEqual({
      _tag: "Available",
      accumulated: Duration.seconds(5),
      activeSince: 12_000,
    })
  })

  it("unions overlapping parent and child intervals instead of adding parallel work", () => {
    const snapshot = fold([
      lifecycle("parent", "parent-start", "execution.started", 0, 1),
      lifecycle("child", "child-start", "execution.started", 5_000, 1),
      lifecycle("child", "child-complete", "execution.completed", 15_000, 2),
      lifecycle("parent", "parent-wait", "wait.created", 10_000, 2),
    ])

    expect(UsageCost.activeTime(snapshot, "thread")).toEqual({
      _tag: "Available",
      accumulated: Duration.seconds(15),
    })
  })

  it("reports the same active time when a persisted fold is reopened and its events re-delivered", () => {
    const events = [
      lifecycle("parent", "start", "execution.started", 1_000, 1),
      lifecycle("parent", "wait", "wait.created", 11_000, 2),
    ]
    const beforeClose = fold(events)
    const reopened = UsageCost.deserialize(UsageCost.serialize(beforeClose))!
    const afterRedelivery = fold(events, { threadId: "thread", turnId: "turn" }, reopened)

    expect(UsageCost.activeTime(afterRedelivery, "thread")).toEqual(UsageCost.activeTime(beforeClose, "thread"))
    expect(UsageCost.activeTime(afterRedelivery, "thread")).toEqual({
      _tag: "Available",
      accumulated: Duration.seconds(10),
    })
  })

  it("counts no time for an unstamped execution and keeps its costs", () => {
    const unstamped = fold([
      unstampedLifecycle("execution", "start", "execution.started", 1_000, 1),
      unstampedLifecycle("execution", "complete", "execution.completed", 11_000, 2),
      usage("cost", 0.25),
    ])
    const mixed = fold([
      unstampedLifecycle("execution", "start", "execution.started", 1_000, 1),
      lifecycle("execution", "complete", "execution.completed", 11_000, 2),
    ])
    const withStamped = fold(
      [
        lifecycle("stamped", "start", "execution.started", 1_000, 1),
        lifecycle("stamped", "complete", "execution.completed", 4_000, 2),
      ],
      { threadId: "thread", turnId: "turn" },
      unstamped,
    )

    expect(UsageCost.activeTime(unstamped, "thread")).toEqual({ _tag: "Unavailable" })
    expect(UsageCost.activeTime(mixed, "thread")).toEqual({ _tag: "Unavailable" })
    expect(UsageCost.turnTotals(unstamped, "turn").costUsd).toBe(0.25)
    expect(UsageCost.activeTime(withStamped, "thread")).toEqual({
      _tag: "Available",
      accumulated: Duration.seconds(3),
    })
  })

  it("treats a regressing timestamp on a server-stamped execution as a defect", () => {
    const stamped = fold([
      lifecycle("execution", "start", "execution.started", 10_000, 1),
      lifecycle("execution", "complete", "execution.completed", 1_000, 2),
    ])
    const withHealthy = fold(
      [
        lifecycle("healthy", "start", "execution.started", 1_000, 1),
        lifecycle("healthy", "done", "execution.completed", 4_000, 2),
      ],
      { threadId: "thread", turnId: "turn" },
      stamped,
    )

    expect(UsageCost.activeTime(stamped, "thread")).toEqual({ _tag: "Unavailable" })
    expect(UsageCost.activeTime(withHealthy, "thread")).toEqual({
      _tag: "Available",
      accumulated: Duration.seconds(3),
    })
  })

  it("reads the mapped event stamp only and ignores a stamp carried in event data", () => {
    const dataStamped = fold([
      {
        ...unstampedLifecycle("execution", "start", "execution.started", 1_000, 1),
        data: { timestamp_source: "server" },
      },
      {
        ...unstampedLifecycle("execution", "complete", "execution.completed", 11_000, 2),
        data: { timestamp_source: "server" },
      },
    ])

    expect(UsageCost.activeTime(dataStamped, "thread")).toEqual({ _tag: "Unavailable" })
  })

  it("makes active time unavailable when lifecycle identity or timestamps are invalid", () => {
    const missingIdentity = fold([
      { executionId: "", cursor: "start", sequence: 1, type: "execution.started", createdAt: 1 },
    ])
    const invalidTimestamp = fold([lifecycle("execution", "start", "execution.started", -1, 1)])

    expect(UsageCost.activeTime(missingIdentity, "thread")).toEqual({ _tag: "Unavailable" })
    expect(UsageCost.activeTime(invalidTimestamp, "thread")).toEqual({ _tag: "Unavailable" })
  })

  it("uses durable sequence order and rejects regressing lifecycle timestamps", () => {
    const snapshot = fold([
      lifecycle("execution", "start", "execution.started", 10_000, 1),
      lifecycle("execution", "wait", "wait.created", 5_000, 2),
    ])

    expect(UsageCost.activeTime(snapshot, "thread")).toEqual({ _tag: "Unavailable" })
  })

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
    expect(UsageCost.turnTotals(recovered, "turn").costUsd).toBe(2.5)
    expect(UsageCost.threadTotals(recovered, "thread").costUsd).toBe(2.5)
    expect(recovered.global.costUsd).toBe(2.5)
  })

  it("totals input and output once while ignoring reasoning and input breakdowns", () => {
    const event = reportedTokens("tokens", "gpt-5.6-sol", 30_000_000, 10_100_000, {
      input_tokens_uncached: 5_000_000,
      input_tokens_cache_read: 20_000_000,
      input_tokens_cache_write: 5_000_000,
      output_tokens_reasoning: 8_000_000,
    })
    const snapshot = UsageCost.observe(UsageCost.empty, { threadId: "thread", turnId: "turn", event })

    expect(UsageCost.threadTotals(snapshot, "thread").tokens).toBe(40_100_000)
    expect(UsageCost.threadTotals(snapshot, "thread").uncountedAttempts === 0).toBe(true)
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

    expect(UsageCost.threadTotals(snapshot, "thread").costUsd).toBe(2)
    expect(UsageCost.threadTotals(snapshot, "thread").unpricedAttempts === 0).toBe(true)
    expect(UsageCost.threadTotals(snapshot, "thread").tokens).toBe(15)
    expect(UsageCost.threadTotals(snapshot, "thread").uncountedAttempts === 0).toBe(true)
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

    expect(UsageCost.threadTotals(snapshot, "thread").uncountedAttempts === 0).toBe(false)
  })

  it("requires released identity and attempt fields only for cost-bearing events", () => {
    const unrelated = UsageCost.observe(UsageCost.empty, {
      threadId: "thread",
      turnId: "turn",
      event: { executionId: "execution", cursor: "output", sequence: 0, type: "workspace.diff", createdAt: 1 },
    })
    const missingIdentity = UsageCost.observe(unrelated, {
      threadId: "thread",
      turnId: "turn",
      event: { ...usage("missing-identity", 1), executionId: "" },
    })
    const missingAttempt = UsageCost.observe(UsageCost.empty, {
      threadId: "thread",
      turnId: "turn",
      event: { ...usage("missing-attempt", 1), data: {} },
    })

    expect(unrelated).toBe(UsageCost.empty)
    expect(missingIdentity.global.unpricedAttempts === 0).toBe(false)
    expect(missingAttempt.global.unpricedAttempts === 0).toBe(false)
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
      expect(snapshot.global.costUsd).toBe(2.5)
      expect(snapshot.global.unpricedAttempts === 0).toBe(true)
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

    expect(snapshot.global.costUsd).toBe(0)
    expect(snapshot.global.unpricedAttempts === 0).toBe(false)
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

    expect(snapshot.global.costUsd).toBeCloseTo(0.0125, 10)
    expect(snapshot.global.unpricedAttempts === 0).toBe(true)
  })

  it("does not estimate nested completed usage and counts it unpriced once it settles", () => {
    const nested = {
      ...usage("nested", 0),
      data: {
        model_call_id: "nested-call",
        model_attempt_id: "nested-attempt",
        attempt: 1,
        usage: { provider: "openai", model: "gpt-5.6-sol", input_tokens: 1_000, output_tokens: 0 },
      },
    }
    const announced = [usage("priced", 1), nested].reduce(
      (current, event) => UsageCost.observe(current, { threadId: "thread", turnId: "turn", event }),
      UsageCost.empty,
    )
    const settled = UsageCost.observe(announced, {
      threadId: "thread",
      turnId: "turn",
      event: lifecycle("execution", "done", "execution.completed", 2, 9),
    })

    expect(announced.global).toMatchObject({ costUsd: 1, unpricedAttempts: 0 })
    expect(settled.global).toMatchObject({ costUsd: 1, unpricedAttempts: 1 })
  })

  it("keeps a thread total while a completed attempt waits for its usage report", () => {
    const priced = UsageCost.observe(UsageCost.empty, {
      threadId: "thread",
      turnId: "turn",
      event: usage("first", 2),
    })
    const awaiting = UsageCost.observe(priced, {
      threadId: "thread",
      turnId: "turn",
      event: attemptCompleted("second", "attempt-second"),
    })
    const reported = UsageCost.observe(awaiting, {
      threadId: "thread",
      turnId: "turn",
      event: reportedTokens("second-usage", "gpt-5.6-sol", 100, 0, {
        model_attempt_id: "attempt-second",
        input_tokens_uncached: 100,
      }),
    })

    expect(UsageCost.threadTotals(awaiting, "thread")).toMatchObject({ costUsd: 2, unpricedAttempts: 0 })
    expect(UsageCost.threadTotals(reported, "thread").costUsd).toBeCloseTo(2.0005, 10)
    expect(UsageCost.threadTotals(reported, "thread").unpricedAttempts).toBe(0)
  })

  it("counts an attempt as unpriced only once it settles without usage", () => {
    const awaiting = UsageCost.observe(UsageCost.empty, {
      threadId: "thread",
      turnId: "turn",
      event: attemptCompleted("truncated", "attempt-truncated"),
    })
    const settled = UsageCost.observe(awaiting, {
      threadId: "thread",
      turnId: "turn",
      event: lifecycle("execution", "done", "execution.completed", 2, 9),
    })

    expect(UsageCost.threadTotals(awaiting, "thread")).toEqual(UsageCost.noTotals)
    expect(awaiting.threads).toBe(UsageCost.empty.threads)
    expect(awaiting.turns).toBe(UsageCost.empty.turns)
    expect(awaiting.global).toBe(UsageCost.empty.global)
    expect(UsageCost.threadTotals(settled, "thread")).toMatchObject({
      costUsd: 0,
      unpricedAttempts: 1,
      uncountedAttempts: 1,
    })
  })

  it("keeps other threads and the global total priced when one thread has an unpriced attempt", () => {
    const priced = UsageCost.observe(UsageCost.empty, {
      threadId: "thread-b",
      turnId: "turn-b",
      event: { ...usage("b", 3), executionId: "execution-b" },
    })
    const awaiting = UsageCost.observe(priced, {
      threadId: "thread-a",
      turnId: "turn-a",
      event: attemptCompleted("a", "attempt-a", "execution-a"),
    })
    const settled = UsageCost.observe(awaiting, {
      threadId: "thread-a",
      turnId: "turn-a",
      event: lifecycle("execution-a", "done", "execution.completed", 2, 9),
    })

    expect(UsageCost.threadTotals(settled, "thread-a")).toMatchObject({ costUsd: 0, unpricedAttempts: 1 })
    expect(UsageCost.threadTotals(settled, "thread-b")).toMatchObject({ costUsd: 3, unpricedAttempts: 0 })
    expect(settled.global).toMatchObject({ costUsd: 3, unpricedAttempts: 1 })
  })

  it("prices a retry that follows a truncated attempt", () => {
    const failed = [
      attemptCompleted("truncated", "attempt-1"),
      { ...attemptCompleted("truncated-failed", "attempt-1"), type: "model.attempt.failed" },
    ].reduce(
      (current, event) => UsageCost.observe(current, { threadId: "thread", turnId: "turn", event }),
      UsageCost.empty,
    )
    const retried = UsageCost.observe(failed, {
      threadId: "thread",
      turnId: "turn",
      event: { ...usage("retry", 1.75), data: { ...usage("retry", 1.75).data, model_attempt_id: "attempt-2" } },
    })

    expect(UsageCost.threadTotals(failed, "thread")).toMatchObject({ costUsd: 0, unpricedAttempts: 1 })
    expect(UsageCost.threadTotals(retried, "thread")).toMatchObject({ costUsd: 1.75, unpricedAttempts: 1 })
  })

  it("deduplicates values by attempt and deliveries by opaque event cursor", () => {
    const first = usage("first", 1)
    const sameAttempt = {
      ...usage("second", 9),
      data: { ...usage("second", 9).data, model_attempt_id: first.data?.model_attempt_id },
    }
    const duplicateDelivery = { ...usage("ignored", 8), cursor: first.cursor }
    const snapshot = [first, sameAttempt, duplicateDelivery].reduce(
      (current, event) => UsageCost.observe(current, { threadId: "thread", turnId: "turn", event }),
      UsageCost.empty,
    )

    expect(snapshot.global.costUsd).toBe(0)
    expect(snapshot.global.unpricedAttempts === 0).toBe(false)
  })

  it("scopes reused attempt ids to their execution", () => {
    const sharedAttempt = (cursor: string, executionId: string, costUsd: number) => ({
      ...usage(cursor, costUsd),
      executionId,
      data: { ...usage(cursor, costUsd).data, model_attempt_id: "attempt-shared" },
    })
    const first = sharedAttempt("cursor-a", "execution-a", 1)
    const second = sharedAttempt("cursor-b", "execution-b", 2)
    const snapshot = [first, second].reduce(
      (current, event) => UsageCost.observe(current, { threadId: "thread", turnId: "turn", event }),
      UsageCost.empty,
    )

    expect(snapshot.global.costUsd).toBe(3)
  })

  it("scopes reused delivery cursors to their execution", () => {
    const sharedDelivery = (executionId: string, costUsd: number) => ({
      ...usage("cursor-shared", costUsd),
      executionId,
      data: { ...usage("cursor-shared", costUsd).data, model_attempt_id: `attempt-${executionId}` },
    })
    const first = sharedDelivery("execution-a", 1)
    const second = sharedDelivery("execution-b", 2)
    const snapshot = [first, second, first].reduce(
      (current, event) => UsageCost.observe(current, { threadId: "thread", turnId: "turn", event }),
      UsageCost.empty,
    )

    expect(snapshot.global.costUsd).toBe(3)
    expect(snapshot.global.pricedAttempts).toBe(2)
  })

  it("does not require dense or arrival-ordered execution sequences", () => {
    const later = { ...usage("later", 2), sequence: 100 }
    const earlier = { ...usage("earlier", 1), sequence: 3 }
    const snapshot = [later, earlier].reduce(
      (current, event) => UsageCost.observe(current, { threadId: "thread", turnId: "turn", event }),
      UsageCost.empty,
    )

    expect(snapshot.global.costUsd).toBe(3)
  })

  it("rolls two children and a grandchild into the parent turn and thread total", () => {
    const snapshot = fold(
      [
        usageIn("parent", "parent-usage", 1),
        usageIn("child-a", "child-a-usage", 2),
        usageIn("child-b", "child-b-usage", 3),
        usageIn("grandchild", "grandchild-usage", 4),
      ],
      { threadId: "thread-a", turnId: "parent" },
    )

    expect(UsageCost.turnTotals(snapshot, "parent").costUsd).toBe(10)
    expect(UsageCost.threadTotals(snapshot, "thread-a").costUsd).toBe(10)
    expect(snapshot.global.costUsd).toBe(10)
  })

  it("adds execution trees across threads into one global total", () => {
    const threadA = fold([usageIn("turn-a", "usage-a", 1.25), usageIn("child-a", "usage-child-a", 0.75)], {
      threadId: "thread-a",
      turnId: "turn-a",
    })
    const snapshot = fold([usageIn("turn-b", "usage-b", 3.5)], { threadId: "thread-b", turnId: "turn-b" }, threadA)

    expect(UsageCost.threadTotals(snapshot, "thread-a").costUsd).toBe(2)
    expect(UsageCost.threadTotals(snapshot, "thread-b").costUsd).toBe(3.5)
    expect(snapshot.global.costUsd).toBe(5.5)
  })

  it("includes every Turn in a Thread total", () => {
    const snapshot = Array.from({ length: 201 }, (_, index) => index).reduce(
      (current, index) =>
        fold([usageIn(`turn-${index}`, `usage-${index}`, 1)], { threadId: "thread", turnId: `turn-${index}` }, current),
      UsageCost.empty,
    )

    expect(snapshot.turns).toHaveLength(201)
    expect(UsageCost.threadTotals(snapshot, "thread").costUsd).toBe(201)
    expect(snapshot.global.costUsd).toBe(201)
  })

  it("charges a separately durable title execution to its first Turn", () => {
    const snapshot = fold([usageIn("turn-first", "turn-usage", 2), usageIn("title:turn-first", "title-usage", 0.25)], {
      threadId: "thread-a",
      turnId: "turn-first",
    })

    expect(UsageCost.turnTotals(snapshot, "turn-first").costUsd).toBe(2.25)
    expect(UsageCost.threadTotals(snapshot, "thread-a").costUsd).toBe(2.25)
    expect(snapshot.global.costUsd).toBe(2.25)
  })

  it("only records turns and threads with observed usage", () => {
    const snapshot = fold([usageIn("turn-a", "usage-a", 2)], { threadId: "thread-a", turnId: "turn-a" })

    expect(snapshot.turns.has("turn-b")).toBe(false)
    expect(snapshot.threads.has("thread-b")).toBe(false)
    expect(UsageCost.turnTotals(snapshot, "turn-a").costUsd).toBe(2)
  })
})
