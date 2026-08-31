import { RunEvent, RunTree } from "generalist/runtime"
import { DateTime } from "effect"
import { describe, expect, it } from "@effect/vitest"
import { TreeProjector } from "../../src/projection/tree/projector"
import type { SemanticTreeEvent } from "../../src/projection/semantic/event"

let position = 0
type RunEventInput = {
  [Tag in Exclude<RunEvent.RunEvent["_tag"], "ModelResponseCommitted" | "ModelResponseInterrupted">]: Partial<
    Extract<RunEvent.RunEvent, { readonly _tag: Tag }>
  > & {
    readonly _tag: Tag
  }
}[Exclude<RunEvent.RunEvent["_tag"], "ModelResponseCommitted" | "ModelResponseInterrupted">]

const treeEvent = (
  runId: string,
  event: RunEventInput,
  options: { readonly rootRunId?: string; readonly parentRunId?: string; readonly invocationId?: string } = {},
): SemanticTreeEvent => {
  position += 1
  const rootRunId = options.rootRunId ?? "raw-root-run"
  const decodedEvent = RunEvent.RunEvent.make({
    specVersion: "1",
    eventId: `${runId}:${position}`,
    runId,
    rootRunId,
    sequence: position,
    executableRef: {
      active: `agent-pin:v1:sha256:${"1".repeat(64)}`,
      executable: `executable-pin:v1:sha256:${"2".repeat(64)}`,
    },
    depth: options.parentRunId === undefined ? 0 : 1,
    occurredAt: occurredAt(position),
    ...event,
  })
  if (decodedEvent._tag === "ModelResponseCommitted" || decodedEvent._tag === "ModelResponseInterrupted") {
    throw new TypeError("Usage projections do not accept model response events")
  }
  const base = {
    event: decodedEvent,
    rootRunId,
    runId,
    cursor: RunTree.TreeCursor.make(`tree-cursor-${position}`),
  }
  if (options.parentRunId === undefined) return base
  if (options.invocationId === undefined) return { ...base, parentRunId: options.parentRunId }
  return { ...base, invocationId: options.invocationId, parentRunId: options.parentRunId }
}

const occurredAt = (millis: number): string => DateTime.formatIso(DateTime.makeUnsafe(millis))

describe("Generalist tree projector usage accounting", () => {
  it("keeps hidden title usage without exposing its transcript", () => {
    position = 0
    const projector = TreeProjector.make("turn-title", "title me")
    projector.apply(
      treeEvent(
        "raw-title-run",
        { _tag: "TurnStarted", turn: 0 },
        { parentRunId: "raw-root-run", invocationId: "rika.thread-title" },
      ),
    )
    const usage = projector.apply(
      treeEvent(
        "raw-title-run",
        {
          _tag: "ModelAttemptCompleted",
          deliveryId: "delivery",
          turn: 0,
          modelCallId: "title-call",
          modelAttemptId: "title-attempt",
          attempt: 0,
          completedAt: 2,
          usageAt: 2,
          usage: {
            inputTokens: { total: 5, uncached: undefined, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 3, text: undefined, reasoning: undefined },
          },
          finishReason: "stop",
          provider: "test",
          model: "title-model",
        },
        { parentRunId: "raw-root-run", invocationId: "rika.thread-title" },
      ),
    )
    expect(usage.state.usage.tokens?.total).toBe(8)
    expect(usage.state.usage.tokens?.input.total).toBe(5)
    expect(usage.state.usage.tokens?.output.total).toBe(3)
    expect(usage.state.usage.countedAttempts).toBe(1)
    expect(usage.state.usage.unpricedAttempts).toBe(1)
    expect(usage.upsert).toEqual([])
  })

  it("counts account-backed attempts as included instead of unpriced", () => {
    position = 0
    const projector = TreeProjector.make("turn-account", "codex", undefined, [], false, "included")
    projector.apply(
      treeEvent("raw-root-run", {
        _tag: "ModelAttemptCompleted",
        deliveryId: "delivery",
        turn: 0,
        modelCallId: "call",
        modelAttemptId: "attempt",
        attempt: 0,
        completedAt: 2,
        usageAt: 2,
        usage: {
          inputTokens: { total: 5, uncached: 5, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 3, text: 3, reasoning: undefined },
        },
        finishReason: "stop",
        provider: "openai",
        model: "codex",
      }),
    )
    const usage = projector.snapshot().state.usage
    expect(usage.tokens?.total).toBe(8)
    expect(usage.tokens?.input.total).toBe(5)
    expect(usage.tokens?.output.total).toBe(3)
    expect(usage.pricedAttempts).toBe(0)
    expect(usage.unpricedAttempts).toBe(0)
    expect(usage.includedAttempts).toBe(1)
    expect(usage.countedAttempts).toBe(1)
    expect(usage.uncountedAttempts).toBe(0)
    expect(usage).not.toHaveProperty("costNanoUsd")
  })

  it("keeps exact cumulative token totals beyond the bounded replay window", () => {
    position = 0
    const projector = TreeProjector.make("turn-many-attempts", "count")
    for (let index = 0; index < 300; index += 1) {
      projector.apply(
        treeEvent("raw-root-run", {
          _tag: "ModelAttemptCompleted",
          deliveryId: `delivery-${index}`,
          turn: 0,
          modelCallId: `call-${index}`,
          modelAttemptId: `attempt-${index}`,
          attempt: 0,
          completedAt: index,
          usageAt: index,
          usage: {
            inputTokens: { total: 2, uncached: 1, cacheRead: 1, cacheWrite: 0 },
            outputTokens: { total: 3, text: 2, reasoning: 1 },
          },
          finishReason: "stop",
        }),
      )
    }
    const snapshot = projector.snapshot()
    expect(snapshot.state.usage).toEqual(
      expect.objectContaining({
        tokens: {
          total: 1_500,
          input: { total: 600, uncached: 300, cacheRead: 300, cacheWrite: 0 },
          output: { total: 900, text: 600, reasoning: 300 },
        },
        countedAttempts: 300,
        uncountedAttempts: 0,
        pricedAttempts: 0,
        unpricedAttempts: 300,
      }),
    )
    expect(snapshot.checkpoint!.state.length).toBeLessThan(1_000_000)
    const resumed = TreeProjector.make("turn-many-attempts", "count", snapshot.checkpoint, snapshot.units)
    expect(resumed.snapshot().state.usage.tokens?.total).toBe(1_500)
  })

  it("preserves failed-provider totals and never invents missing provider cost", () => {
    position = 0
    const projector = TreeProjector.make("turn-provider-facts", "facts")
    projector.apply(
      treeEvent("raw-root-run", {
        _tag: "ModelAttemptFailed",
        deliveryId: "failed-delivery",
        turn: 0,
        modelCallId: "failed-call",
        modelAttemptId: "failed-attempt",
        attempt: 0,
        failedAt: 1,
        category: "provider-response",
        classification: "transient",
        disposition: "retry",
        providerUsage: { inputTokens: 7, outputTokens: 5, totalTokens: 15 },
      }),
    )
    projector.apply(
      treeEvent("raw-root-run", {
        _tag: "ModelAttemptCompleted",
        deliveryId: "priced-delivery",
        turn: 0,
        modelCallId: "priced-call",
        modelAttemptId: "priced-attempt",
        attempt: 0,
        completedAt: 2,
        usageAt: 2,
        usage: {
          inputTokens: { total: 11, uncached: 8, cacheRead: 2, cacheWrite: 1 },
          outputTokens: { total: 4, text: 3, reasoning: 1 },
        },
        finishReason: "stop",
      }),
    )
    const usage = projector.snapshot().state.usage
    expect(usage).toEqual(
      expect.objectContaining({
        pricedAttempts: 0,
        unpricedAttempts: 2,
        countedAttempts: 2,
        uncountedAttempts: 0,
      }),
    )
    expect(usage).not.toHaveProperty("costNanoUsd")
    expect(usage.tokens).toEqual({
      total: 30,
      input: { total: 18, uncached: 8, cacheRead: 2, cacheWrite: 1 },
      output: { total: 9, text: 3, reasoning: 1 },
      failedProviderTotal: 15,
    })
  })

  it("publishes only the newest root conversation context reading", () => {
    position = 0
    const projector = TreeProjector.make("turn-context", "context")
    projector.apply(
      treeEvent("raw-root-run", {
        _tag: "ModelCallStarted",
        deliveryId: "one",
        turn: 0,
        modelCallId: "call-one",
        purpose: "conversation",
        startedAt: 1,
      }),
    )
    projector.apply(
      treeEvent("raw-root-run", {
        _tag: "ModelAttemptCompleted",
        deliveryId: "one-attempt",
        turn: 0,
        modelCallId: "call-one",
        modelAttemptId: "attempt-one",
        attempt: 0,
        completedAt: 2,
        usageAt: 2,
        usage: { inputTokens: { total: 20 }, outputTokens: { total: 2 } },
        finishReason: "stop",
      }),
    )
    expect(projector.snapshot().state.usage).toEqual(
      expect.objectContaining({
        context: { requestOrdinal: 1, purpose: "conversation", inputTokens: 20 },
        contextPending: false,
      }),
    )
    projector.apply(
      treeEvent("raw-root-run", {
        _tag: "ModelCallStarted",
        deliveryId: "two",
        turn: 1,
        modelCallId: "call-two",
        purpose: "conversation",
        startedAt: 3,
      }),
    )
    expect(projector.snapshot().state.usage).toEqual(
      expect.objectContaining({
        context: { requestOrdinal: 1, purpose: "conversation", inputTokens: 20 },
        contextPending: true,
      }),
    )
    projector.apply(
      treeEvent("raw-root-run", {
        _tag: "ModelAttemptCompleted",
        deliveryId: "two-attempt",
        turn: 1,
        modelCallId: "call-two",
        modelAttemptId: "attempt-two",
        attempt: 0,
        completedAt: 4,
        usageAt: 4,
        usage: { inputTokens: { total: 30 }, outputTokens: { total: 3 } },
        finishReason: "stop",
      }),
    )
    expect(projector.snapshot().state.usage).toEqual(
      expect.objectContaining({
        context: { requestOrdinal: 2, purpose: "conversation", inputTokens: 30 },
        contextPending: false,
      }),
    )
    projector.apply(
      treeEvent(
        "raw-child-run",
        {
          _tag: "ModelCallStarted",
          deliveryId: "child",
          turn: 0,
          modelCallId: "child-call",
          purpose: "conversation",
          startedAt: 5,
        },
        { parentRunId: "raw-root-run", invocationId: "child" },
      ),
    )
    projector.apply(
      treeEvent(
        "raw-child-run",
        {
          _tag: "ModelAttemptCompleted",
          deliveryId: "child-attempt-delivery",
          turn: 0,
          modelCallId: "child-call",
          modelAttemptId: "child-attempt",
          attempt: 0,
          completedAt: 6,
          usageAt: 6,
          usage: { inputTokens: { total: 999 }, outputTokens: { total: 1 } },
          finishReason: "stop",
        },
        { parentRunId: "raw-root-run", invocationId: "child" },
      ),
    )
    expect(projector.snapshot().state.usage.context).toEqual({
      requestOrdinal: 2,
      purpose: "conversation",
      inputTokens: 30,
    })
  })

  it("computes active time as the union of overlapping run intervals and restores it", () => {
    position = 0
    const projector = TreeProjector.make("turn-active", "active")
    projector.apply(
      treeEvent("raw-root-run", {
        _tag: "RunAttemptStarted",
        attempt: 1,
        occurredAt: occurredAt(10),
      }),
    )
    projector.apply(
      treeEvent(
        "raw-child-run",
        {
          _tag: "RunAttemptStarted",
          attempt: 1,
          occurredAt: occurredAt(20),
        },
        { parentRunId: "raw-root-run", invocationId: "child" },
      ),
    )
    projector.apply(
      treeEvent("raw-root-run", {
        _tag: "RunWaiting",
        occurredAt: occurredAt(30),
        wait: { waitId: "wait", status: "open", openedAt: occurredAt(30), reason: { _tag: "Timer" } },
      }),
    )
    const childDone = projector.apply(
      treeEvent(
        "raw-child-run",
        {
          _tag: "RunCompleted",
          occurredAt: occurredAt(40),
          result: { text: "", turns: 1, session: { sessionId: "child-session", leafId: null } },
        },
        { parentRunId: "raw-root-run", invocationId: "child" },
      ),
    )
    expect(childDone.state.usage.active).toEqual({ _tag: "Available", accumulatedMillis: 30 })
    projector.apply(
      treeEvent("raw-root-run", {
        _tag: "RunResumed",
        occurredAt: occurredAt(50),
        waitId: "wait",
        resolution: { _tag: "Signal", name: "resume" },
      }),
    )
    const resumed = TreeProjector.make(
      "turn-active",
      "active",
      projector.snapshot().checkpoint,
      projector.snapshot().units,
    )
    const completed = resumed.apply(
      treeEvent("raw-root-run", {
        _tag: "RunCompleted",
        occurredAt: occurredAt(70),
        result: {
          text: "aggregate output must not project",
          turns: 1,
          session: { sessionId: "root-session", leafId: null },
        },
      }),
    )
    expect(completed.state.usage.active).toEqual({ _tag: "Available", accumulatedMillis: 50 })
    expect(completed.state.usage.sourceComplete).toBe(true)
    expect(
      completed.upsert.filter((unit) => unit.content._tag === "Entry" && unit.content.role === "assistant"),
    ).toEqual([])
  })

  it("fails loudly instead of evicting genuinely in-flight attempts", () => {
    position = 0
    const projector = TreeProjector.make("turn-in-flight-bound", "bound")
    for (let index = 0; index < 256; index += 1)
      projector.apply(
        treeEvent("raw-root-run", {
          _tag: "ModelAttemptStarted",
          deliveryId: `delivery-${index}`,
          turn: 0,
          modelCallId: `call-${index}`,
          modelAttemptId: `attempt-${index}`,
          attempt: 0,
          startedAt: index,
        }),
      )
    expect(() =>
      projector.apply(
        treeEvent("raw-root-run", {
          _tag: "ModelAttemptStarted",
          deliveryId: "overflow",
          turn: 0,
          modelCallId: "overflow",
          modelAttemptId: "overflow",
          attempt: 0,
          startedAt: 257,
        }),
      ),
    ).toThrow(/in-flight attempts exceeds 256/)
  })
})
