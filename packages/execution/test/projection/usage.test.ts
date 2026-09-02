import { DateTime } from "effect"
import { describe, expect, it } from "@effect/vitest"
import { Run } from "generalist/runtime"
import { TreeProjector } from "../../src/projection/tree/projector"
import { resetEventPosition, treeEvent } from "../support/projector-event.fixture"

const completed = (input: {
  readonly runId?: string
  readonly turn: number
  readonly call: string
  readonly attempt: string
  readonly input: number
  readonly output: number
}): Run.RawUsageFact => ({
  _tag: "Completed",
  runId: input.runId ?? "raw-root-run",
  turn: input.turn,
  purpose: "conversation",
  modelCallId: input.call,
  modelAttemptId: input.attempt,
  attempt: 0,
  usageAt: input.turn,
  usage: {
    inputTokens: { total: input.input, uncached: input.input, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: input.output, text: input.output, reasoning: 0 },
  },
})

const failed: Run.RawUsageFact = {
  _tag: "Failed",
  runId: "raw-root-run",
  turn: 0,
  purpose: "conversation",
  modelCallId: "failed-call",
  modelAttemptId: "failed-attempt",
  attempt: 0,
  category: "provider-response",
  usageAt: 1,
  providerUsage: { inputTokens: 7, outputTokens: 5, totalTokens: 15 },
}

const occurredAt = (millis: number): string => DateTime.formatIso(DateTime.makeUnsafe(millis))

describe("Generalist checkpoint usage presentation", () => {
  it("derives exact token, attempt, and context totals from authoritative raw facts", () => {
    const projector = TreeProjector.make("turn-facts", "facts")
    projector.replaceUsage("raw-root-run", [
      completed({ turn: 0, call: "call-one", attempt: "attempt-one", input: 20, output: 2 }),
      completed({ turn: 1, call: "call-two", attempt: "attempt-two", input: 30, output: 3 }),
      failed,
    ])

    expect(projector.snapshot().state.usage).toEqual(
      expect.objectContaining({
        context: { requestOrdinal: 2, purpose: "conversation", inputTokens: 30 },
        countedAttempts: 3,
        uncountedAttempts: 0,
        pricedAttempts: 0,
        unpricedAttempts: 3,
        tokens: {
          total: 70,
          input: { total: 57, uncached: 50, cacheRead: 0, cacheWrite: 0 },
          output: { total: 10, text: 5, reasoning: 0 },
          failedProviderTotal: 15,
        },
      }),
    )
  })

  it("replaces rather than recounts a newer Generalist checkpoint", () => {
    const projector = TreeProjector.make("turn-replace", "facts")
    const first = completed({ turn: 0, call: "call-one", attempt: "attempt-one", input: 5, output: 3 })
    const second = completed({ turn: 1, call: "call-two", attempt: "attempt-two", input: 7, output: 4 })
    projector.replaceUsage("raw-root-run", [first])
    projector.replaceUsage("raw-root-run", [first, second])

    expect(projector.snapshot().state.usage.tokens?.total).toBe(19)
    expect(projector.snapshot().state.usage.countedAttempts).toBe(2)
  })

  it("presents account-backed facts as included", () => {
    const projector = TreeProjector.make("turn-included", "facts", { pricing: "included" })
    projector.replaceUsage("raw-root-run", [
      completed({ turn: 0, call: "call-one", attempt: "attempt-one", input: 5, output: 3 }),
    ])

    expect(projector.snapshot().state.usage).toEqual(
      expect.objectContaining({ includedAttempts: 1, pricedAttempts: 0, unpricedAttempts: 0 }),
    )
  })

  it("includes separately inspected title Run facts without exposing title transcript", () => {
    resetEventPosition()
    const projector = TreeProjector.make("turn-title", "title me", { titleExpected: true })
    projector.apply(treeEvent("raw-root-run", { _tag: "TurnStarted", turn: 0 }))
    projector.replaceUsage("raw-root-run", [])
    const patch = projector.applyTitle(undefined, [
      completed({
        runId: "raw-title-run",
        turn: 0,
        call: "title-call",
        attempt: "title-attempt",
        input: 5,
        output: 3,
      }),
    ])

    expect(patch?.state.usage.tokens?.total).toBe(8)
    expect(patch?.upsert).toEqual([])
  })

  it("computes active time from replayed durable lifecycle events", () => {
    resetEventPosition()
    const projector = TreeProjector.make("turn-active", "active")
    projector.apply(treeEvent("raw-root-run", { _tag: "RunAttemptStarted", attempt: 1, occurredAt: occurredAt(10) }))
    projector.apply(
      treeEvent("raw-root-run", {
        _tag: "RunWaiting",
        occurredAt: occurredAt(30),
        wait: { waitId: "wait", status: "open", openedAt: occurredAt(30), reason: { _tag: "Timer" } },
      }),
    )
    projector.apply(
      treeEvent("raw-root-run", {
        _tag: "RunResumed",
        occurredAt: occurredAt(50),
        waitId: "wait",
        resolution: { _tag: "Signal", name: "resume" },
      }),
    )
    const completion = projector.apply(
      treeEvent("raw-root-run", {
        _tag: "RunCompleted",
        occurredAt: occurredAt(70),
        result: { text: "", turns: 1, session: { sessionId: "root-session", leafId: null } },
      }),
    )

    expect(completion.state.usage.active).toEqual({ _tag: "Available", accumulatedMillis: 40 })
  })

  it("rejects duplicate facts in an authoritative checkpoint", () => {
    const projector = TreeProjector.make("turn-duplicate", "facts")
    const fact = completed({ turn: 0, call: "call-one", attempt: "attempt-one", input: 5, output: 3 })
    expect(() => projector.replaceUsage("raw-root-run", [fact, fact])).toThrow(/duplicate usage fact/)
  })
})
