import { describe, expect, it } from "@effect/vitest"
import * as Thread from "@rika/product/thread-record"
import * as Turn from "@rika/product/turn-record"
import * as ExecutionRouteSnapshot from "@rika/product/execution-route-snapshot"
import * as InteractiveFeedOverflow from "../src/operation/interactive/interactive-feed-overflow"

describe("interactive feed overflow", () => {
  const turn: Turn.Turn = {
    _tag: "AgentExecution",
    id: Turn.TurnId.make("turn"),
    threadId: Thread.ThreadId.make("thread"),
    prompt: "prompt",
    status: "running",
    executionRoute: ExecutionRouteSnapshot.testExecutionRoute(),
    author: { _tag: "Human" },
    lineage: { _tag: "Original" },
    createdAt: 0,
    updatedAt: 0,
  }

  it("collapses repeated transcript activity into one ordered resync", () => {
    const state = InteractiveFeedOverflow.make()
    for (let index = 0; index < 2; index += 1)
      InteractiveFeedOverflow.remember(state, {
        _tag: "TranscriptProjectionPatched",
        selectionEpoch: 7,
        threadId: turn.threadId,
        rootTurnId: turn.id,
        streamId: "stream",
        baseRevision: index,
        patchRevision: index + 1,
        origin: { _tag: "Discovery", executionId: "execution:turn" },
        state: { revision: index, modelPhase: 0 },
        delta: { upsert: [], remove: [] },
      })

    expect(state.criticalOverflowed).toBe(false)
    expect(InteractiveFeedOverflow.events(state, 7, "bounded")).toEqual([
      {
        _tag: "TranscriptResyncRequired",
        selectionEpoch: 7,
        threadId: "thread",
        reason: "bounded",
      },
    ])
  })

  it("survives a transcript patch storm with one resync per thread and no terminal overflow", () => {
    const state = InteractiveFeedOverflow.make()
    const threadIds = ["thread-a", "thread-b"]
    for (let index = 0; index < InteractiveFeedOverflow.capacity * 4; index += 1)
      InteractiveFeedOverflow.remember(state, {
        _tag: "TranscriptProjectionPatched",
        selectionEpoch: 3,
        threadId: Thread.ThreadId.make(threadIds[index % threadIds.length]!),
        rootTurnId: turn.id,
        streamId: "stream",
        baseRevision: index,
        patchRevision: index + 1,
        origin: { _tag: "Discovery", executionId: "execution:turn" },
        state: { revision: index, modelPhase: 0 },
        delta: { upsert: [], remove: [] },
      })

    expect(state.criticalOverflowed).toBe(false)
    expect(state.critical).toHaveLength(0)
    expect(InteractiveFeedOverflow.events(state, 3, "bounded")).toEqual([
      { _tag: "TranscriptResyncRequired", selectionEpoch: 3, threadId: "thread-a", reason: "bounded" },
      { _tag: "TranscriptResyncRequired", selectionEpoch: 3, threadId: "thread-b", reason: "bounded" },
    ])
  })

  it("retains distinct outcomes in arrival order", () => {
    const state = InteractiveFeedOverflow.make()
    for (let index = 0; index < 12; index += 1)
      InteractiveFeedOverflow.remember(state, {
        _tag: "ExecutionFailed",
        selectionEpoch: 0,
        message: String(index),
      })

    expect(state.critical.map((event) => (event._tag === "ExecutionFailed" ? event.message : ""))).toEqual(
      Array.from({ length: 12 }, (_, index) => String(index)),
    )
  })

  it("coalesces terminal settlements by turn and sequence", () => {
    const state = InteractiveFeedOverflow.make()
    InteractiveFeedOverflow.remember(state, {
      _tag: "TurnSettled",
      selectionEpoch: 1,
      activitySequence: 2,
      threadId: turn.threadId,
      turnId: turn.id,
      status: "completed",
    })
    InteractiveFeedOverflow.remember(state, {
      _tag: "TurnSettled",
      selectionEpoch: 1,
      activitySequence: 1,
      threadId: turn.threadId,
      turnId: turn.id,
      status: "failed",
    })

    expect(InteractiveFeedOverflow.events(state, 1, "bounded")).toEqual([
      {
        _tag: "TurnSettled",
        selectionEpoch: 1,
        activitySequence: 2,
        threadId: turn.threadId,
        turnId: turn.id,
        status: "completed",
      },
    ])
  })

  it("coalesces usage snapshots without overflowing the recovery window", () => {
    const state = InteractiveFeedOverflow.make()
    for (let index = 0; index < InteractiveFeedOverflow.capacity + 20; index += 1)
      InteractiveFeedOverflow.remember(state, {
        _tag: "ThreadUsageUpdated",
        selectionEpoch: 7,
        threadId: Thread.ThreadId.make("thread"),
        revision: index,
        context: { _tag: "Available", inputTokens: index, contextWindow: 1_050_000, reserveTokens: 128_000 },
        cost: { _tag: "Available", usd: index, unpricedAttempts: 0 },
        tokens: { _tag: "Available", total: index, uncountedAttempts: 0 },
        time: { _tag: "Available", accumulatedMillis: index },
      })

    expect(state.criticalOverflowed).toBe(false)
    expect(InteractiveFeedOverflow.events(state, 7, "bounded")).toEqual([
      {
        _tag: "ThreadUsageUpdated",
        selectionEpoch: 7,
        threadId: "thread",
        revision: InteractiveFeedOverflow.capacity + 19,
        context: {
          _tag: "Available",
          inputTokens: InteractiveFeedOverflow.capacity + 19,
          contextWindow: 1_050_000,
          reserveTokens: 128_000,
        },
        cost: { _tag: "Available", usd: InteractiveFeedOverflow.capacity + 19, unpricedAttempts: 0 },
        tokens: { _tag: "Available", total: InteractiveFeedOverflow.capacity + 19, uncountedAttempts: 0 },
        time: { _tag: "Available", accumulatedMillis: InteractiveFeedOverflow.capacity + 19 },
      },
    ])
  })

  it("recovers an overflowed projection snapshot as an authoritative transcript resync", () => {
    const state = InteractiveFeedOverflow.make()
    InteractiveFeedOverflow.remember(state, {
      _tag: "TranscriptProjectionStarted",
      selectionEpoch: 7,
      threadId: turn.threadId,
      rootTurnId: turn.id,
      turn,
      streamId: "stream",
      patchRevision: 0,
      state: { revision: 0, modelPhase: 0 },
      units: [],
    })

    expect(InteractiveFeedOverflow.events(state, 7, "bounded")).toEqual([
      {
        _tag: "TranscriptResyncRequired",
        selectionEpoch: 7,
        threadId: "thread",
        reason: "bounded",
      },
    ])
  })

  it("latches terminal overflow without growing past the bound", () => {
    const state = InteractiveFeedOverflow.make()
    for (let index = 0; index < InteractiveFeedOverflow.capacity + 1; index += 1)
      InteractiveFeedOverflow.remember(state, {
        _tag: "ExecutionFailed",
        selectionEpoch: 0,
        message: String(index),
      })

    expect(state.criticalOverflowed).toBe(true)
    expect(state.critical).toHaveLength(InteractiveFeedOverflow.capacity)
  })

  it("latches terminal overflow for too many unique recovery threads", () => {
    const state = InteractiveFeedOverflow.make()
    for (let index = 0; index < InteractiveFeedOverflow.capacity + 1; index += 1)
      InteractiveFeedOverflow.remember(state, {
        _tag: "TranscriptResyncRequired",
        selectionEpoch: 0,
        threadId: Thread.ThreadId.make(String(index)),
        reason: "bounded",
      })

    expect(state.criticalOverflowed).toBe(true)
    expect(state.transcriptThreadIds.size).toBe(InteractiveFeedOverflow.capacity)
  })
})
