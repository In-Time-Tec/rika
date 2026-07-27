import { describe, expect, it } from "@effect/vitest"
import type * as ExecutionBackend from "@rika/runtime/contract"
import { BackendError } from "@rika/runtime/contract"
import { Duration, Effect } from "effect"
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
): ExecutionBackend.Event => ({
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

  it("uses observed work timestamps when Relay terminal lifecycle timestamps equal the start", () => {
    const snapshot = [
      lifecycle("execution", "start", "execution.started", 1_000, 1),
      {
        id: "output",
        executionId: "execution",
        cursor: "output",
        sequence: 2,
        type: "model.output.delta",
        createdAt: 5_000,
      },
      lifecycle("execution", "complete", "execution.completed", 1_000, 3),
    ].reduce(
      (current, event) => UsageCost.observe(current, { threadId: "thread", turnId: "turn", event }),
      UsageCost.empty,
    )

    expect(UsageCost.activeTime(snapshot, "thread")).toEqual({
      _tag: "Available",
      accumulated: Duration.seconds(4),
    })
  })

  it("uses observed work timestamps when a Relay wait timestamp equals the start", () => {
    const snapshot = [
      lifecycle("execution", "start", "execution.started", 1_000, 1),
      {
        executionId: "execution",
        cursor: "tool",
        sequence: 2,
        type: "tool.call.requested",
        createdAt: 5_000,
      },
      lifecycle("execution", "wait", "wait.created", 1_000, 3),
    ].reduce(
      (current, event) => UsageCost.observe(current, { threadId: "thread", turnId: "turn", event }),
      UsageCost.empty,
    )

    expect(UsageCost.activeTime(snapshot, "thread")).toEqual({
      _tag: "Available",
      accumulated: Duration.seconds(4),
    })
  })

  it("admits work evidence that repairs stale Relay timestamps into the observed stream", () => {
    const work: ExecutionBackend.Event = {
      executionId: "execution",
      cursor: "tool",
      sequence: 2,
      type: "tool.call.requested",
      createdAt: 5_000,
    }
    const snapshot = [
      lifecycle("execution", "start", "execution.started", 1_000, 1),
      work,
      lifecycle("execution", "wait", "wait.created", 1_000, 3),
    ]
      .filter((event) => UsageCost.isObservedEvent(event))
      .reduce(
        (current, event) => UsageCost.observe(current, { threadId: "thread", turnId: "turn", event }),
        UsageCost.empty,
      )

    expect(UsageCost.isUsageBearingEvent(work)).toBe(false)
    expect(UsageCost.activeTime(snapshot, "thread")).toEqual({
      _tag: "Available",
      accumulated: Duration.seconds(4),
    })
  })

  it("repairs a stale wait after its earlier work evidence arrives late", () => {
    const events = [
      lifecycle("execution", "start", "execution.started", 1_000, 1),
      {
        executionId: "execution",
        cursor: "tool",
        sequence: 2,
        type: "tool.call.requested",
        createdAt: 5_000,
      },
      lifecycle("execution", "wait", "wait.created", 1_000, 3),
    ]
    const snapshot = [events[0]!, events[2]!, events[1]!].reduce(
      (current, event) => UsageCost.observe(current, { threadId: "thread", turnId: "turn", event }),
      UsageCost.empty,
    )

    expect(UsageCost.activeTime(snapshot, "thread")).toEqual({
      _tag: "Available",
      accumulated: Duration.seconds(4),
    })
  })

  it("preserves completed work when a resumed execution has a stale terminal timestamp", () => {
    const snapshot = [
      lifecycle("execution", "start-1", "execution.started", 1_000, 1),
      lifecycle("execution", "wait", "wait.created", 6_000, 2),
      lifecycle("execution", "start-2", "execution.started", 10_000, 3),
      {
        id: "output",
        executionId: "execution",
        cursor: "output",
        sequence: 4,
        type: "model.output.delta",
        createdAt: 12_000,
      },
      lifecycle("execution", "complete", "execution.completed", 1_000, 5),
    ].reduce(
      (current, event) => UsageCost.observe(current, { threadId: "thread", turnId: "turn", event }),
      UsageCost.empty,
    )

    expect(UsageCost.activeTime(snapshot, "thread")).toEqual({
      _tag: "Available",
      accumulated: Duration.seconds(7),
    })
  })

  it("uses a durable wait wake time when the resumed start and terminal timestamps are stale", () => {
    const snapshot = [
      lifecycle("execution", "start-1", "execution.started", 1_000, 1),
      lifecycle("execution", "wait", "wait.created", 2_000, 7),
      lifecycle("execution", "wake", "wait.woken", 10_000, 12),
      lifecycle("execution", "start-2", "execution.started", 1_000, 13),
      {
        id: "output",
        executionId: "execution",
        cursor: "output",
        sequence: 21,
        type: "model.output.delta",
        createdAt: 12_000,
      },
      lifecycle("execution", "complete", "execution.completed", 1_000, 27),
    ].reduce(
      (current, event) => UsageCost.observe(current, { threadId: "thread", turnId: "turn", event }),
      UsageCost.empty,
    )

    expect(UsageCost.activeTime(snapshot, "thread")).toEqual({
      _tag: "Available",
      accumulated: Duration.seconds(3),
    })
  })

  it("falls back to resumed work evidence when replay omits a durable wait wake", () => {
    const snapshot = [
      lifecycle("execution", "start-1", "execution.started", 1_000, 1),
      lifecycle("execution", "wait", "wait.created", 2_000, 7),
      lifecycle("execution", "start-2", "execution.started", 1_000, 13),
      {
        id: "model-start",
        executionId: "execution",
        cursor: "model-start",
        sequence: 18,
        type: "model.call.started",
        createdAt: 10_000,
      },
      {
        id: "output",
        executionId: "execution",
        cursor: "output",
        sequence: 21,
        type: "model.output.delta",
        createdAt: 12_000,
      },
      lifecycle("execution", "complete", "execution.completed", 1_000, 27),
    ].reduce(
      (current, event) => UsageCost.observe(current, { threadId: "thread", turnId: "turn", event }),
      UsageCost.empty,
    )

    expect(UsageCost.activeTime(snapshot, "thread")).toEqual({
      _tag: "Available",
      accumulated: Duration.seconds(3),
    })
  })

  it("repairs an open stale resumed start when work evidence arrives", () => {
    const snapshot = [
      lifecycle("execution", "start-1", "execution.started", 1_000, 1),
      lifecycle("execution", "wait", "wait.created", 2_000, 7),
      lifecycle("execution", "start-2", "execution.started", 1_000, 13),
      {
        id: "model-start",
        executionId: "execution",
        cursor: "model-start",
        sequence: 18,
        type: "model.call.started",
        createdAt: 10_000,
      },
    ].reduce(
      (current, event) => UsageCost.observe(current, { threadId: "thread", turnId: "turn", event }),
      UsageCost.empty,
    )

    expect(UsageCost.activeTime(snapshot, "thread")).toEqual({
      _tag: "Available",
      accumulated: Duration.seconds(1),
      activeSince: 10_000,
    })
  })

  it("resumes active time from a durable wait timeout", () => {
    const snapshot = [
      lifecycle("execution", "start-1", "execution.started", 1_000, 1),
      lifecycle("execution", "wait", "wait.created", 2_000, 7),
      lifecycle("execution", "timeout", "wait.timed_out", 10_000, 12),
      lifecycle("execution", "start-2", "execution.started", 1_000, 13),
      lifecycle("execution", "complete", "execution.completed", 12_000, 14),
    ].reduce(
      (current, event) => UsageCost.observe(current, { threadId: "thread", turnId: "turn", event }),
      UsageCost.empty,
    )

    expect(UsageCost.activeTime(snapshot, "thread")).toEqual({
      _tag: "Available",
      accumulated: Duration.seconds(3),
    })
  })

  it("resumes active time when Relay continues directly from a durable wake", () => {
    const snapshot = [
      lifecycle("execution", "start", "execution.started", 1_000, 1),
      lifecycle("execution", "wait", "wait.created", 2_000, 7),
      lifecycle("execution", "wake", "wait.woken", 10_000, 12),
      lifecycle("execution", "complete", "execution.completed", 12_000, 27),
    ].reduce(
      (current, event) => UsageCost.observe(current, { threadId: "thread", turnId: "turn", event }),
      UsageCost.empty,
    )

    expect(UsageCost.activeTime(snapshot, "thread")).toEqual({
      _tag: "Available",
      accumulated: Duration.seconds(3),
    })
  })

  it("does not rebuild active intervals for each appended streaming delta", () => {
    const resumed = [
      lifecycle("execution", "start-1", "execution.started", 1_000, 1),
      lifecycle("execution", "wait", "wait.created", 2_000, 7),
      lifecycle("execution", "wake", "wait.woken", 10_000, 12),
      lifecycle("execution", "start-2", "execution.started", 1_000, 13),
    ].reduce(
      (current, event) => UsageCost.observe(current, { threadId: "thread", turnId: "turn", event }),
      UsageCost.empty,
    )
    const activeIntervals = resumed.threadActiveTime
    const streamed = Array.from({ length: 2_000 }, (_, index) => ({
      id: `output-${index}`,
      executionId: "execution",
      cursor: `output-${index}`,
      sequence: 14 + index,
      type: "model.output.delta",
      createdAt: 10_001 + index,
    })).reduce((current, event) => UsageCost.observe(current, { threadId: "thread", turnId: "turn", event }), resumed)

    expect(streamed.threadActiveTime).toBe(activeIntervals)
    expect(UsageCost.activeTime(streamed, "thread")).toEqual({
      _tag: "Available",
      accumulated: Duration.seconds(1),
      activeSince: 10_000,
    })
  })

  it("rejects conflicting work evidence at one durable sequence", () => {
    const snapshot = [
      lifecycle("execution", "start", "execution.started", 1_000, 1),
      {
        id: "output-a",
        executionId: "execution",
        cursor: "output-a",
        sequence: 2,
        type: "model.output.delta",
        createdAt: 5_000,
      },
      {
        id: "output-b",
        executionId: "execution",
        cursor: "output-b",
        sequence: 2,
        type: "model.output.delta",
        createdAt: 50_000,
      },
      lifecycle("execution", "complete", "execution.completed", 1_000, 3),
    ].reduce(
      (current, event) => UsageCost.observe(current, { threadId: "thread", turnId: "turn", event }),
      UsageCost.empty,
    )

    expect(UsageCost.activeTime(snapshot, "thread")).toEqual({ _tag: "Unavailable" })
  })

  it("does not count work evidence observed while an execution is waiting", () => {
    const snapshot = [
      lifecycle("execution", "start-1", "execution.started", 1_000, 1),
      lifecycle("execution", "wait", "wait.created", 6_000, 2),
      {
        id: "idle-output",
        executionId: "execution",
        cursor: "idle-output",
        sequence: 3,
        type: "model.output.delta",
        createdAt: 15_000,
      },
      lifecycle("execution", "start-2", "execution.started", 10_000, 4),
      lifecycle("execution", "complete", "execution.completed", 1_000, 5),
    ].reduce(
      (current, event) => UsageCost.observe(current, { threadId: "thread", turnId: "turn", event }),
      UsageCost.empty,
    )

    expect(UsageCost.activeTime(snapshot, "thread")).toEqual({
      _tag: "Available",
      accumulated: Duration.seconds(5),
    })
  })

  it("assigns out-of-order work evidence by durable sequence instead of delivery order", () => {
    const events = [
      lifecycle("execution", "start-1", "execution.started", 1_000, 1),
      lifecycle("execution", "wait", "wait.created", 6_000, 2),
      lifecycle("execution", "start-2", "execution.started", 10_000, 3),
      {
        id: "output",
        executionId: "execution",
        cursor: "output",
        sequence: 4,
        type: "model.output.delta",
        createdAt: 12_000,
      },
      lifecycle("execution", "complete", "execution.completed", 1_000, 5),
    ]
    const project = (ordered: ReadonlyArray<ExecutionBackend.Event>) =>
      ordered.reduce(
        (current, event) => UsageCost.observe(current, { threadId: "thread", turnId: "turn", event }),
        UsageCost.empty,
      )
    const durable = project(events)
    const live = project([events[0]!, events[3]!, events[1]!, events[2]!, events[4]!])

    expect(UsageCost.activeTime(live, "thread")).toEqual(UsageCost.activeTime(durable, "thread"))
    expect(UsageCost.activeTime(live, "thread")).toEqual({
      _tag: "Available",
      accumulated: Duration.seconds(7),
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

  it.effect("restores elapsed work from persisted model timestamps when Relay terminal timestamps are stale", () =>
    Effect.gen(function* () {
      const executions = {
        parent: {
          events: [
            lifecycle("parent", "start", "execution.started", 1_000, 1),
            {
              id: "output",
              executionId: "parent",
              cursor: "output",
              sequence: 2,
              type: "model.output.delta",
              createdAt: 5_000,
            },
            lifecycle("parent", "complete", "execution.completed", 1_000, 3),
          ],
        },
      }

      const restored = yield* UsageCost.collect(reader(executions), [{ threadId: "thread", turnId: "parent" }])

      expect(UsageCost.activeTime(restored, "thread")).toEqual({
        _tag: "Available",
        accumulated: Duration.seconds(4),
      })
    }),
  )

  it("makes active time unavailable when lifecycle identity or timestamps are invalid", () => {
    const missingIdentity = UsageCost.observe(UsageCost.empty, {
      threadId: "thread",
      turnId: "turn",
      event: { executionId: "", cursor: "start", sequence: 1, type: "execution.started", createdAt: 1 },
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

  it("does not require dense or arrival-ordered execution sequences", () => {
    const later = { ...usage("later", 2), sequence: 100 }
    const earlier = { ...usage("earlier", 1), sequence: 3 }
    const snapshot = [later, earlier].reduce(
      (current, event) => UsageCost.observe(current, { threadId: "thread", turnId: "turn", event }),
      UsageCost.empty,
    )

    expect(snapshot.global.costUsd).toBe(3)
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

      expect(UsageCost.turnTotals(snapshot, "parent").costUsd).toBe(10)
      expect(UsageCost.threadTotals(snapshot, "thread-a").costUsd).toBe(10)
      expect(snapshot.global.costUsd).toBe(10)
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

      expect(UsageCost.threadTotals(snapshot, "thread-a").costUsd).toBe(2)
      expect(UsageCost.threadTotals(snapshot, "thread-b").costUsd).toBe(3.5)
      expect(snapshot.global.costUsd).toBe(5.5)
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
      expect(snapshot.threads).toHaveLength(100)
      expect(UsageCost.threadTotals(snapshot, "thread-0").costUsd).toBe(1)
      expect(snapshot.threads.has("thread-100")).toBe(false)
      expect(snapshot.global.costUsd).toBe(100)
    }),
  )

  it.effect("includes every Turn in a Thread total", () =>
    Effect.gen(function* () {
      const executions = Object.fromEntries(
        Array.from({ length: 201 }, (_, index) => [`turn-${index}`, { events: [usage(`usage-${index}`, 1)] }]),
      )
      const roots = Array.from({ length: 201 }, (_, index) => ({ threadId: "thread", turnId: `turn-${index}` }))
      const snapshot = yield* UsageCost.collect(reader(executions), roots)

      expect(snapshot.turns).toHaveLength(201)
      expect(UsageCost.threadTotals(snapshot, "thread").costUsd).toBe(201)
      expect(snapshot.global.costUsd).toBe(201)
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

      expect(UsageCost.turnTotals(snapshot, "turn-first").costUsd).toBe(2.25)
      expect(UsageCost.threadTotals(snapshot, "thread-a").costUsd).toBe(2.25)
      expect(snapshot.global.costUsd).toBe(2.25)
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

      expect(UsageCost.turnTotals(snapshot, "turn-a").costUsd).toBe(1.5)
      expect(UsageCost.threadTotals(snapshot, "thread-b").costUsd).toBe(3)
      expect(snapshot.global.costUsd).toBe(4.5)
      expect(UsageCost.threadTotals(snapshot, "thread-a").unpricedAttempts).toBe(1)
      expect(UsageCost.threadTotals(snapshot, "thread-b").unpricedAttempts).toBe(0)
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

      expect(snapshot.turns.has("turn-b")).toBe(false)
      expect(snapshot.threads.has("thread-b")).toBe(false)
      expect(UsageCost.turnTotals(snapshot, "turn-a").costUsd).toBe(2)
    }),
  )
})
