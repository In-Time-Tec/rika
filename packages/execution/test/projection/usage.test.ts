import { RunTree, type RunEvent } from "tenetkit/runtime"
import { DateTime } from "effect"
import { describe, expect, it } from "@effect/vitest"
import { TreeProjector } from "../../src/projection/tree/projector"
import type { SemanticTreeEvent } from "../../src/projection/semantic/event"

let position = 0
const treeEvent = (
  runId: string,
  event: Partial<RunEvent.RunEvent> & { readonly _tag: RunEvent.RunEvent["_tag"] },
  options: { readonly rootRunId?: string; readonly parentRunId?: string; readonly invocationId?: string } = {},
): SemanticTreeEvent => {
  position += 1
  const rootRunId = options.rootRunId ?? "raw-root-run"
  return {
    rootRunId,
    runId,
    ...(options.parentRunId === undefined ? {} : { parentRunId: options.parentRunId }),
    ...(options.invocationId === undefined ? {} : { invocationId: options.invocationId }),
    event: {
      specVersion: "1",
      eventId: `${runId}:${position}`,
      runId,
      rootRunId,
      sequence: position,
      executableRef: {} as never,
      occurredAt: occurredAt(position),
      ...event,
    } as SemanticTreeEvent["event"],
    cursor: RunTree.TreeCursor.make(`tree-cursor-${position}`),
  }
}

const occurredAt = (millis: number): string => DateTime.formatIso(DateTime.makeUnsafe(millis))

describe("TenetKit tree projector usage accounting", () => {
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
    expect(usage.state.usage).toEqual(
      expect.objectContaining({
        tokens: expect.objectContaining({
          total: 8,
          input: expect.objectContaining({ total: 5 }),
          output: expect.objectContaining({ total: 3 }),
        }),
        countedAttempts: 1,
        unpricedAttempts: 1,
      }),
    )
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
    expect(usage).toEqual(
      expect.objectContaining({
        tokens: expect.objectContaining({
          total: 8,
          input: expect.objectContaining({ total: 5 }),
          output: expect.objectContaining({ total: 3 }),
        }),
        pricedAttempts: 0,
        unpricedAttempts: 0,
        includedAttempts: 1,
        countedAttempts: 1,
        uncountedAttempts: 0,
      }),
    )
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
        } as never),
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
        classification: "retryable",
        disposition: "retry",
        providerUsage: { inputTokens: 7, outputTokens: 5, totalTokens: 15 },
      } as never),
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
        cost: { amount: 0.125, currency: "USD" },
      } as never),
    )
    const usage = projector.snapshot().state.usage
    expect(usage).toEqual(
      expect.objectContaining({
        costNanoUsd: 125_000_000,
        pricedAttempts: 1,
        unpricedAttempts: 1,
        countedAttempts: 2,
        uncountedAttempts: 0,
      }),
    )
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
      } as never),
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
      } as never),
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
      } as never),
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
      } as never),
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
        } as never,
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
        } as never,
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
        wait: { waitId: "wait", status: "open", openedAt: occurredAt(30), reason: { _tag: "Input" } },
      } as never),
    )
    const childDone = projector.apply(
      treeEvent(
        "raw-child-run",
        {
          _tag: "RunCompleted",
          occurredAt: occurredAt(40),
          result: { text: "", turns: 1, transcript: [] },
        } as never,
        { parentRunId: "raw-root-run", invocationId: "child" },
      ),
    )
    expect(childDone.state.usage.active).toEqual({ _tag: "Available", accumulatedMillis: 30 })
    projector.apply(
      treeEvent("raw-root-run", {
        _tag: "RunResumed",
        occurredAt: occurredAt(50),
        waitId: "wait",
        resolution: { _tag: "Provided", value: null },
      } as never),
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
        result: { text: "aggregate output must not project", turns: 1, transcript: [] },
      } as never),
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
        } as never),
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
        } as never),
      ),
    ).toThrow(/in-flight attempts exceeds 256/)
  })
})
