import { describe, expect, it } from "@effect/vitest"
import { Duration, Result } from "effect"
import * as Support from "./usage-test-support"

describe("UsageCost", () => {
  it.each([
    ["missing-server-stamp", Support.Fixtures.unstampedLifecycle("execution", "start", "execution.started", 1, 1)],
    ["invalid-identity", Support.Fixtures.lifecycle("", "start", "execution.started", 1, 1)],
    ["invalid-timestamp", Support.Fixtures.lifecycle("execution", "start", "execution.started", -1, 1)],
    ["invalid-sequence", Support.Fixtures.lifecycle("execution", "start", "execution.started", 1, -1)],
  ] as const)("fails lifecycle projection with %s without changing its input", (reason, event) => {
    const result = Support.RawUsageCost.observe(Support.RawUsageCost.empty, {
      threadId: "thread",
      turnId: "turn",
      event,
    })
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) expect(result.failure.reason).toBe(reason)
    expect(Support.RawUsageCost.empty.activeEvents.size).toBe(0)
  })

  it("fails a batch atomically and accepts corrected evidence afterward", () => {
    const observations = [
      Support.Fixtures.lifecycle("execution", "start", "execution.started", 1, 1),
      Support.Fixtures.lifecycle("execution", "wait", "wait.created", 0, 2),
    ].map((event) => ({ threadId: "thread", turnId: "turn", event }))
    const folded = Support.RawUsageCost.foldBatch(Support.RawUsageCost.empty, observations)
    expect(Result.isSuccess(folded)).toBe(true)
    if (Result.isSuccess(folded)) expect(folded.success.activeEvents.size).toBe(2)
    expect(Support.RawUsageCost.empty.activeEvents.size).toBe(0)
  })

  it("validates a Relay root alias against its canonical execution identity", () => {
    const result = Support.RawUsageCost.foldBatch(
      Support.RawUsageCost.empty,
      [
        Support.Fixtures.lifecycle("execution:turn", "start", "execution.started", 1, 1),
        Support.Fixtures.lifecycle("execution:turn", "done", "execution.completed", 2, 2),
      ].map((event) => ({ threadId: "thread", turnId: "turn", event })),
      new Set(["turn"]),
    )
    expect(Result.isSuccess(result)).toBe(true)
    if (Result.isSuccess(result)) expect(result.success.executionEvents.has("turn")).toBe(true)
  })

  it("distinguishes unsupported snapshots from malformed current JSON", () => {
    const unsupported = Support.RawUsageCost.deserialize(JSON.stringify({ version: 3 }))
    const malformed = Support.RawUsageCost.deserialize(JSON.stringify({ version: Support.RawUsageCost.foldVersion }))
    expect(Result.isFailure(unsupported) && unsupported.failure.reason).toBe("unsupported-version")
    expect(Result.isFailure(malformed) && malformed.failure.reason).toBe("decode-failure")
  })

  it("keeps replay reference identity after persistence and rejects conflicting cursor reuse", () => {
    const input = { threadId: "thread", turnId: "turn", event: Support.Fixtures.usage("cursor", 1) }
    const first = Support.RawUsageCost.observe(Support.RawUsageCost.empty, input)
    expect(Result.isSuccess(first)).toBe(true)
    if (Result.isFailure(first)) return
    const decoded = Support.RawUsageCost.deserialize(Support.RawUsageCost.serialize(first.success))
    expect(Result.isSuccess(decoded)).toBe(true)
    if (Result.isFailure(decoded)) return
    const replay = Support.RawUsageCost.observe(decoded.success, input)
    expect(Result.isSuccess(replay) && replay.success).toBe(decoded.success)
    const conflict = Support.RawUsageCost.observe(decoded.success, {
      ...input,
      event: Support.Fixtures.usage("cursor", 2),
    })
    expect(Result.isFailure(conflict) && conflict.failure.reason).toBe("cursor-conflict")
  })

  it("rejects lifecycle cursor replay from another turn", () => {
    const event = Support.Fixtures.lifecycle("execution", "start", "execution.started", 1, 1)
    const first = Support.unwrap(
      Support.RawUsageCost.observe(Support.RawUsageCost.empty, { threadId: "thread", turnId: "turn-a", event }),
    )
    const replay = Support.RawUsageCost.observe(first, { threadId: "thread", turnId: "turn-b", event })
    expect(Result.isFailure(replay) && replay.failure.reason).toBe("cursor-conflict")
  })

  it("canonicalizes equivalent attempt payload key order", () => {
    const event = Support.Fixtures.usage("cursor", 1)
    const reordered = {
      ...event,
      data: { cost: event.data?.cost, attempt: 1, model_attempt_id: "attempt-cursor", model_call_id: "call-cursor" },
    }
    const first = Support.unwrap(
      Support.RawUsageCost.observe(Support.RawUsageCost.empty, { threadId: "thread", turnId: "turn", event }),
    )
    const replay = Support.RawUsageCost.observe(first, { threadId: "thread", turnId: "turn", event: reordered })
    expect(Result.isSuccess(replay) && replay.success).toBe(first)
  })

  it("accepts parallel waits and their independent wake outcomes", () => {
    const result = Support.RawUsageCost.foldBatch(
      Support.RawUsageCost.empty,
      [
        Support.Fixtures.lifecycle("execution", "start", "execution.started", 1, 1),
        Support.Fixtures.lifecycle("execution", "wait-a", "wait.created", 2, 2),
        Support.Fixtures.lifecycle("execution", "wait-b", "wait.created", 3, 3),
        Support.Fixtures.lifecycle("execution", "wake-a", "wait.woken", 4, 4),
        Support.Fixtures.lifecycle("execution", "cancel-b", "wait.cancelled", 5, 5),
        Support.Fixtures.lifecycle("execution", "done", "execution.completed", 6, 6),
      ].map((event) => ({ threadId: "thread", turnId: "turn", event })),
    )
    expect(Result.isSuccess(result)).toBe(true)
  })

  it("rejects malformed nested snapshot state", () => {
    const serialized = JSON.parse(Support.RawUsageCost.serialize(Support.RawUsageCost.empty))
    serialized.activeEvents = [["key", { executionId: 1 }]]
    const result = Support.RawUsageCost.deserialize(JSON.stringify(serialized))
    expect(Result.isFailure(result) && result.failure.reason).toBe("decode-failure")
  })

  it("reports duplicate sequences, post-terminal events, and invalid complete transitions", () => {
    const duplicate = Support.RawUsageCost.foldBatch(
      Support.RawUsageCost.empty,
      [
        Support.Fixtures.lifecycle("execution", "start", "execution.started", 1, 1),
        Support.Fixtures.lifecycle("execution", "wait", "wait.created", 1, 1),
      ].map((event) => ({ threadId: "thread", turnId: "turn", event })),
    )
    expect(Result.isFailure(duplicate) && duplicate.failure.reason).toBe("duplicate-sequence")
    const postTerminal = Support.RawUsageCost.foldBatch(
      Support.RawUsageCost.empty,
      [
        Support.Fixtures.lifecycle("execution", "done", "execution.completed", 1, 1),
        Support.Fixtures.lifecycle("execution", "start", "execution.started", 2, 2),
      ].map((event) => ({ threadId: "thread", turnId: "turn", event })),
    )
    expect(Result.isFailure(postTerminal) && postTerminal.failure.reason).toBe("post-terminal")
    const invalid = Support.RawUsageCost.foldBatch(
      Support.RawUsageCost.empty,
      [
        {
          threadId: "thread",
          turnId: "turn",
          event: Support.Fixtures.lifecycle("execution", "wake", "wait.woken", 1, 1),
        },
      ],
      new Set(["execution"]),
    )
    expect(Result.isFailure(invalid) && invalid.failure.reason).toBe("invalid-transition")
  })

  it("persists only the latest exact conversational root context reading", () => {
    const input = { threadId: "thread", turnId: "turn" }
    const events = [
      {
        ...Support.Fixtures.reportedTokens("conversation-1", "gpt-5.6-sol", 120, 10),
        sequence: 4,
      },
      {
        ...Support.Fixtures.reportedTokens("compaction", "gpt-5.6-sol", 40, 5, {
          model_call_id: "call:compaction-summary",
          model_attempt_id: "attempt-compaction",
        }),
        sequence: 5,
      },
      {
        ...Support.Fixtures.reportedTokens("structured", "gpt-5.6-sol", 60, 5, {
          model_call_id: "call:structured-output",
          model_attempt_id: "attempt-structured",
        }),
        sequence: 6,
      },
      {
        ...Support.Fixtures.reportedTokens("conversation-2", "gpt-5.6-sol", 180, 12),
        sequence: 7,
      },
    ]
    const folded = events.reduce(
      (snapshot, event) => Support.UsageCost.observe(snapshot, { ...input, event }),
      Support.UsageCost.empty,
    )
    expect([...folded.executionContexts.values()]).toEqual([
      {
        inputTokens: 180,
        sequence: 7,
        modelCallId: "call-conversation-2",
        modelAttemptId: "attempt-conversation-2",
        attempt: 1,
      },
    ])
    expect([...Support.UsageCost.deserialize(Support.UsageCost.serialize(folded)).executionContexts.values()]).toEqual([
      ...folded.executionContexts.values(),
    ])
  })

  it("round trips every fold state and continues identically", () => {
    const input = { threadId: "thread", turnId: "turn" }
    const before = [
      Support.Fixtures.lifecycle("execution", "accepted", "execution.accepted", 1_000, 1),
      Support.Fixtures.lifecycle("execution", "started", "execution.started", 2_000, 2),
      Support.Fixtures.usage("cost", 0.25),
    ].reduce((snapshot, event) => Support.UsageCost.observe(snapshot, { ...input, event }), Support.UsageCost.empty)
    const after = [
      Support.Fixtures.reportedTokens("tokens", "gpt-4o", 10, 5),
      Support.Fixtures.lifecycle("execution", "completed", "execution.completed", 5_000, 4),
    ]
    const uninterrupted = after.reduce(
      (snapshot, event) => Support.UsageCost.observe(snapshot, { ...input, event }),
      before,
    )
    const resumed = after.reduce(
      (snapshot, event) => Support.UsageCost.observe(snapshot, { ...input, event }),
      Support.UsageCost.deserialize(Support.UsageCost.serialize(before))!,
    )
    expect(Support.UsageCost.serialize(resumed)).toBe(Support.UsageCost.serialize(uninterrupted))
    expect(Support.UsageCost.observe(resumed, { ...input, event: after[0]! })).toEqual(resumed)
  })

  it("treats an unknown fold version as absent and recomputes through refold", () => {
    const events = [
      Support.Fixtures.lifecycle("execution", "start", "execution.started", 1_000, 1),
      Support.Fixtures.usage("cost", 0.25),
      Support.Fixtures.lifecycle("execution", "complete", "execution.completed", 11_000, 2),
    ]
    const current = Support.Fixtures.fold(events)
    const unknown = JSON.stringify({
      ...JSON.parse(Support.UsageCost.serialize(current)),
      version: Support.UsageCost.foldVersion - 1,
    })

    expect(Result.isFailure(Support.RawUsageCost.deserialize(unknown))).toBe(true)
    const refolded = Support.Fixtures.fold(events, { threadId: "thread", turnId: "turn" }, Support.UsageCost.empty)
    expect(Support.UsageCost.turnTotals(refolded, "turn").costUsd).toBe(0.25)
    expect(Support.UsageCost.activeTime(refolded, "thread")).toEqual({
      _tag: "Available",
      accumulated: Duration.seconds(10),
    })
  })
})
