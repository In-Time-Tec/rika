import { describe, expect, it } from "vitest"
import * as ExecutionProjection from "@rika/product/execution-projection"
import * as Turn from "@rika/product/turn-record"
import { makeThreadViewFeed } from "../../../../src/operation/interactive/view/thread"
import { thread, threadId, turn, turnId } from "./thread.fixture"

const unit = (key: string, text: string) => ({
  key,
  turnId: String(turnId),
  order: [{ sequence: 1, part: 0, key }],
  revision: 1,
  content: { _tag: "Entry" as const, role: "assistant" as const, text },
})
const state = (status: "running" | "waiting" | "completed" = "running") => ({
  status,
  usage: ExecutionProjection.emptyUsageState(),
  steering: { steeringMessages: 0, followUpMessages: 0 },
})

describe("interactive ThreadView feed", () => {
  it("updates closed aggregate usage atomically in the same ThreadView patch", () => {
    const feed = makeThreadViewFeed(() => 1)
    feed.publish({
      _tag: "SelectionLoaded",
      selectionEpoch: 1,
      activitySequence: 0,
      thread,
      entries: [],
      hasOlder: false,
      usage: {
        usage: {
          costNanoUsd: 100,
          tokens: { total: 10, input: { total: 7 }, output: { total: 3 } },
          pricedAttempts: 1,
          unpricedAttempts: 0,
          countedAttempts: 1,
          uncountedAttempts: 0,
          sourceComplete: true,
          context: { requestOrdinal: 1, purpose: "conversation", inputTokens: 7 },
          contextPending: false,
          active: { _tag: "Available", accumulatedMillis: 20 },
        },
        contextCapacity: { contextWindow: 100, reserveTokens: 10 },
      },
      queueRevision: 0,
      queue: [],
      activeTurn: turn,
    })
    const firstUsage: ExecutionProjection.UsageState = {
      costNanoUsd: 50,
      tokens: {
        total: 8,
        input: { total: 5, cacheRead: 2 },
        output: { total: 3, reasoning: 1 },
        failedProviderTotal: 4,
      },
      pricedAttempts: 1,
      unpricedAttempts: 1,
      countedAttempts: 1,
      uncountedAttempts: 1,
      sourceComplete: false,
      context: { requestOrdinal: 1, purpose: "conversation", inputTokens: 5 },
      contextPending: false,
      active: { _tag: "Available", accumulatedMillis: 30, activeSince: 1_000 },
    }
    const first = feed.publish({
      _tag: "ExecutionProjectionChanged",
      threadId,
      turn,
      change: {
        _tag: "ProjectionSnapshot",
        revision: 0,
        units: [unit("usage", "usage")],
        hasOlder: false,
        state: { status: "running", usage: firstUsage, steering: { steeringMessages: 0, followUpMessages: 0 } },
      },
    })
    expect(first).toMatchObject([
      {
        _tag: "ThreadViewPatch",
        patch: {
          header: {
            usage: {
              state: {
                costNanoUsd: 150,
                tokens: {
                  total: 18,
                  input: { total: 12, cacheRead: 2 },
                  output: { total: 6, reasoning: 1 },
                  failedProviderTotal: 4,
                },
                pricedAttempts: 2,
                unpricedAttempts: 1,
                countedAttempts: 2,
                uncountedAttempts: 1,
                context: { requestOrdinal: 1, purpose: "conversation", inputTokens: 5 },
                active: { _tag: "Available", accumulatedMillis: 50, activeSince: 1_000 },
              },
              contextCapacity: { contextWindow: 372_000, reserveTokens: 128_000 },
            },
          },
        },
      },
    ])
    const secondUsage: ExecutionProjection.UsageState = {
      ...firstUsage,
      costNanoUsd: 75,
      tokens: {
        total: 12,
        input: { total: 8, cacheRead: 3 },
        output: { total: 4, reasoning: 1 },
        failedProviderTotal: 4,
      },
      pricedAttempts: 2,
      countedAttempts: 2,
      sourceComplete: true,
      active: { _tag: "Available", accumulatedMillis: 45 },
    }
    feed.publish({
      _tag: "ExecutionProjectionChanged",
      threadId,
      turn: { ...turn, status: "completed" },
      change: {
        _tag: "ProjectionPatch",
        baseRevision: 0,
        revision: 1,
        checkpoint: { version: ExecutionProjection.projectionVersion, cursor: "private", state: "private" },
        upsert: [],
        remove: [],
        state: { status: "completed", usage: secondUsage, steering: { steeringMessages: 0, followUpMessages: 0 } },
      },
    })
    expect(feed.current()?.usage.state).toMatchObject({
      costNanoUsd: 175,
      tokens: { total: 22, input: { total: 15, cacheRead: 3 }, output: { total: 7, reasoning: 1 } },
      pricedAttempts: 3,
      countedAttempts: 3,
      active: { _tag: "Available", accumulatedMillis: 65 },
    })
    expect(JSON.stringify(feed.current())).not.toMatch(/modelCallId|modelAttemptId|raw-root|private/)
  })

  it("delivers every unit of a full snapshot without re-bounding the timeline", () => {
    const feed = makeThreadViewFeed(() => 1)
    const historyId = Turn.TurnId.make("history")
    const historyTurn: Turn.Turn = { ...turn, id: historyId, prompt: "history", createdAt: 0, updatedAt: 0 }
    const historyEntries = Array.from({ length: 130 }, (_, sequence) => ({
      turn: historyTurn,
      unit: {
        key: `history:${sequence}`,
        turnId: String(historyId),
        order: [{ sequence, part: 0, key: `history:${sequence}` }],
        revision: 1,
        content: { _tag: "Entry" as const, role: "assistant" as const, text: String(sequence) },
      },
      projectionRevision: 1,
      projectionModelPhase: -1,
      projectionState: state("completed"),
    }))
    feed.publish({
      _tag: "SelectionLoaded",
      selectionEpoch: 1,
      activitySequence: 0,
      thread,
      entries: historyEntries,
      hasOlder: false,
      hasNewer: false,
      usage: { usage: ExecutionProjection.emptyUsageState() },
      queueRevision: 0,
      queue: [],
      activeTurn: turn,
    })
    expect(feed.current()?.hasNewer).toBe(false)
    expect(feed.current()?.turns.map((entry) => entry.turn.id)).toEqual([historyId, turn.id])
    expect(feed.current()?.turns[0]?.units).toHaveLength(130)

    const live = feed.publish({
      _tag: "ExecutionProjectionChanged",
      threadId,
      turn,
      change: {
        _tag: "ProjectionPatch",
        baseRevision: 0,
        revision: 1,
        checkpoint: { version: ExecutionProjection.projectionVersion, cursor: "private", state: "private" },
        upsert: [unit("answer", "live")],
        remove: [],
        state: state(),
      },
    })
    expect(live).toMatchObject([
      {
        _tag: "ThreadViewPatch",
        patch: { upsert: [{ content: { text: "live" } }] },
      },
    ])
    expect(feed.current()?.turns.map((entry) => entry.turn.id)).toEqual([historyId, turn.id])
  })

  it("resyncs an unknown turn ahead of a historical window instead of dropping its units", () => {
    const feed = makeThreadViewFeed(() => 1)
    feed.publish({
      _tag: "SelectionLoaded",
      selectionEpoch: 1,
      activitySequence: 0,
      thread,
      entries: [
        {
          turn,
          unit: unit("history", "history"),
          projectionRevision: 1,
          projectionModelPhase: -1,
          projectionState: state("completed"),
        },
      ],
      hasOlder: false,
      hasNewer: true,
      usage: { usage: ExecutionProjection.emptyUsageState() },
      queueRevision: 0,
      queue: [],
    })
    const newTurn: Turn.Turn = {
      ...turn,
      id: Turn.TurnId.make("new-recorded-shell"),
      createdAt: 2,
      updatedAt: 2,
    }
    expect(
      feed.publish({
        _tag: "ExecutionProjectionChanged",
        threadId,
        turn: newTurn,
        change: {
          _tag: "ProjectionSnapshot",
          revision: 1,
          checkpoint: { version: ExecutionProjection.projectionVersion, cursor: "private", state: "private" },
          units: [{ ...unit("shell", "ALLOWED"), turnId: String(newTurn.id) }],
          state: state("completed"),
        },
      }),
    ).toMatchObject([{ _tag: "ResyncRequired", threadId }])
  })

  it("inserts a new snapshot turn directly at the live tail", () => {
    const feed = makeThreadViewFeed(() => 1)
    feed.publish({
      _tag: "SelectionLoaded",
      selectionEpoch: 1,
      activitySequence: 0,
      thread,
      entries: [],
      hasOlder: false,
      hasNewer: false,
      usage: { usage: ExecutionProjection.emptyUsageState() },
      queueRevision: 0,
      queue: [],
    })
    const newTurn: Turn.Turn = {
      ...turn,
      id: Turn.TurnId.make("new-recorded-shell-live"),
      createdAt: 2,
      updatedAt: 2,
    }
    expect(
      feed.publish({
        _tag: "ExecutionProjectionChanged",
        threadId,
        turn: newTurn,
        change: {
          _tag: "ProjectionSnapshot",
          revision: 1,
          checkpoint: { version: ExecutionProjection.projectionVersion, cursor: "private", state: "private" },
          units: [{ ...unit("shell-live", "ALLOWED"), turnId: String(newTurn.id) }],
          state: state("completed"),
        },
      }),
    ).toMatchObject([{ _tag: "ThreadViewPatch", patch: { upsert: [{ content: { text: "ALLOWED" } }] } }])
    expect(feed.current()?.turns.map((entry) => entry.turn.id)).toEqual([newTurn.id])
  })
})
