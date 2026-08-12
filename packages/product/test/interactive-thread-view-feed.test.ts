import * as ExecutionProjection from "@rika/product/execution-projection"
import { describe, expect, it } from "vitest"
import * as Thread from "@rika/product/thread-record"
import * as Turn from "@rika/product/turn-record"
import * as ExecutionRouteSnapshot from "@rika/product/execution-route-snapshot"
import { makeThreadViewFeed } from "../src/operation/interactive/interactive-thread-view-feed"

const threadId = Thread.ThreadId.make("thread")
const turnId = Turn.TurnId.make("turn")
const thread: Thread.Thread = {
  id: threadId,
  workspace: "/workspace",
  title: "Thread",
  labels: [],
  pinned: false,
  archived: false,
  lineage: { _tag: "Original" },
  createdAt: 1,
  updatedAt: 1,
}
const turn: Turn.Turn = {
  _tag: "AgentExecution",
  id: turnId,
  threadId,
  prompt: "prompt",
  status: "running",
  executionRoute: ExecutionRouteSnapshot.testExecutionRoute(),
  author: { _tag: "Human" },
  lineage: { _tag: "Original" },
  createdAt: 1,
  updatedAt: 1,
}
const unit = (key: string, text: string) => ({
  key,
  turnId: String(turnId),
  order: [{ sequence: 1, part: 0, key }],
  revision: 1,
  content: { _tag: "Entry" as const, role: "assistant" as const, text },
})
const state = (status: "running" | "completed" = "running") => ({
  status,
  usage: ExecutionProjection.emptyUsageState(),
  steering: { steeringMessages: 0, followUpMessages: 0 },
})

describe("interactive ThreadView feed", () => {
  it("maps direct Projection Changes without exposing gateway checkpoints", () => {
    const feed = makeThreadViewFeed(() => 1)
    const selected = feed.publish({
      _tag: "SelectionLoaded",
      selectionEpoch: 1,
      activitySequence: 0,
      thread,
      entries: [],
      hasOlder: false,
      usage: { usage: ExecutionProjection.emptyUsageState() },
      queueRevision: 0,
      queue: [],
      activeTurn: turn,
    })
    expect(selected[0]?._tag).toBe("ThreadViewSnapshot")

    const started = feed.publish({
      _tag: "ExecutionProjectionChanged",
      threadId,
      turn,
      change: {
        _tag: "ProjectionSnapshot",
        revision: 0,
        checkpoint: {
          version: ExecutionProjection.projectionVersion,
          cursor: "gateway:snapshot",
          state: "secret-state",
        },
        units: [unit("answer", "one")],
        hasOlder: false,
        state: state(),
      },
    })
    expect(started[0]).toMatchObject({
      _tag: "ThreadViewPatch",
      patch: {
        baseRevision: 0,
        revision: 1,
        header: { source: { projectionVersion: ExecutionProjection.projectionVersion } },
      },
    })

    const patched = feed.publish({
      _tag: "ExecutionProjectionChanged",
      threadId,
      turn: { ...turn, status: "completed" },
      change: {
        _tag: "ProjectionPatch",
        baseRevision: 0,
        revision: 1,
        checkpoint: { version: ExecutionProjection.projectionVersion, cursor: "gateway:patch", state: "secret-state" },
        upsert: [unit("answer", "done")],
        remove: [],
        state: state("completed"),
      },
    })
    expect(patched[0]).toMatchObject({
      _tag: "ThreadViewPatch",
      patch: {
        baseRevision: 1,
        revision: 2,
        header: { source: { projectionVersion: ExecutionProjection.projectionVersion } },
      },
    })
    expect(JSON.stringify([...selected, ...started, ...patched])).not.toMatch(/gateway:|secret-state|checkpoint/)
  })

  it("carries the first turn's prompt unit in the created-thread base snapshot", () => {
    const feed = makeThreadViewFeed(() => 1)
    const selected = feed.publish({
      _tag: "SelectionLoaded",
      selectionEpoch: 1,
      activitySequence: 0,
      thread,
      entries: [],
      hasOlder: false,
      usage: { usage: ExecutionProjection.emptyUsageState() },
      queueRevision: 0,
      queue: [],
      activeTurn: { ...turn, status: "accepted" },
    })
    expect(selected[0]).toMatchObject({ _tag: "ThreadViewSnapshot" })
    const snapshot = (
      selected[0] as {
        readonly snapshot: { readonly turns: ReadonlyArray<{ readonly units: ReadonlyArray<unknown> }> }
      }
    ).snapshot
    const units = snapshot.turns.flatMap((entry) => entry.units)
    expect(units).toContainEqual({
      key: "turn:turn:user",
      turnId: "turn",
      order: [{ sequence: -1, part: 0, key: "turn:turn:user" }],
      revision: 0,
      content: { _tag: "Entry", role: "user", text: "prompt" },
    })
  })

  it("projects accepted steering until its exact consumed unit arrives", () => {
    const feed = makeThreadViewFeed(() => 1)
    feed.publish({
      _tag: "SelectionLoaded",
      selectionEpoch: 1,
      activitySequence: 0,
      thread,
      entries: [],
      hasOlder: false,
      usage: { usage: ExecutionProjection.emptyUsageState() },
      queueRevision: 0,
      queue: [],
      activeTurn: turn,
    })
    const pending = { runId: "run-a", entryId: "entry-a", requestId: "request-a", sequence: 1, text: "same text" }
    feed.publish({
      _tag: "ExecutionProjectionChanged",
      threadId,
      turn,
      change: {
        _tag: "ProjectionSnapshot",
        revision: 0,
        units: [],
        hasOlder: false,
        state: {
          status: "running",
          usage: ExecutionProjection.emptyUsageState(),
          steering: { steeringMessages: 1, followUpMessages: 0, pending: [pending] },
        },
      },
    })
    expect(feed.current()?.turns[0]?.pendingSteering).toEqual([pending])

    const key = ExecutionProjection.steeringUnitKey(
      String(turnId),
      pending.runId,
      pending.requestId,
      pending.entryId,
      pending.sequence,
    )
    feed.publish({
      _tag: "ExecutionProjectionChanged",
      threadId,
      turn,
      change: {
        _tag: "ProjectionPatch",
        baseRevision: 0,
        revision: 1,
        upsert: [
          {
            key,
            turnId: String(turnId),
            order: [{ sequence: 2, part: 0, key }],
            revision: 1,
            content: { _tag: "Entry", role: "user", text: pending.text },
          },
        ],
        remove: [],
        state: {
          status: "running",
          usage: ExecutionProjection.emptyUsageState(),
          steering: {
            steeringMessages: 1,
            followUpMessages: 0,
            pending: [],
            settled: [
              {
                runId: pending.runId,
                entryId: pending.entryId,
                requestId: pending.requestId,
                sequence: pending.sequence,
                outcome: "consumed",
              },
            ],
          },
        },
      },
    })
    expect(feed.current()?.turns[0]?.pendingSteering).toEqual([])
    expect(feed.current()?.turns[0]?.settledSteering).toEqual([
      {
        runId: pending.runId,
        entryId: pending.entryId,
        requestId: pending.requestId,
        sequence: pending.sequence,
        outcome: "consumed",
      },
    ])
    expect(feed.current()?.turns[0]?.units.filter((candidate) => candidate.key === key)).toHaveLength(1)
  })

  it("emits typed resync and stops patching after a projection revision gap", () => {
    const feed = makeThreadViewFeed(() => 1)
    feed.publish({
      _tag: "SelectionLoaded",
      selectionEpoch: 1,
      activitySequence: 0,
      thread,
      entries: [],
      hasOlder: false,
      usage: { usage: ExecutionProjection.emptyUsageState() },
      queueRevision: 0,
      queue: [],
      activeTurn: turn,
    })
    const events = feed.publish({
      _tag: "ExecutionProjectionChanged",
      threadId,
      turn,
      change: {
        _tag: "ProjectionPatch",
        baseRevision: 9,
        revision: 10,
        checkpoint: { version: ExecutionProjection.projectionVersion, cursor: "gap", state: "gap" },
        upsert: [],
        remove: [],
        state: state(),
      },
    })
    expect(events[0]).toMatchObject({ _tag: "ResyncRequired", threadId })
    expect(feed.publish({ _tag: "ThreadTitled", threadId: String(threadId), title: "ignored" })).toEqual([])
  })

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

  it("keeps every unit of one large turn instead of amputating its oldest units", () => {
    const feed = makeThreadViewFeed(() => 1)
    feed.publish({
      _tag: "SelectionLoaded",
      selectionEpoch: 1,
      activitySequence: 0,
      thread,
      entries: [],
      hasOlder: false,
      usage: { usage: ExecutionProjection.emptyUsageState() },
      queueRevision: 0,
      queue: [],
      activeTurn: turn,
    })
    const units = Array.from({ length: 200 }, (_, index) => unit(`subagent:${index}`, String(index)))
    const published = feed.publish({
      _tag: "ExecutionProjectionChanged",
      threadId,
      turn,
      change: {
        _tag: "ProjectionSnapshot",
        revision: 1,
        checkpoint: { version: ExecutionProjection.projectionVersion, cursor: "private", state: "private" },
        units,
        hasOlder: false,
        state: state(),
      },
    })
    expect(published.some((value) => value._tag === "ResyncRequired")).toBe(false)
    expect(feed.current()?.turns[0]?.units.map((value) => value.key)).toContain("subagent:0")
    expect(feed.current()?.turns[0]?.units).toHaveLength(200)
  })

  it("does not remove previously shown units when a snapshot is itself truncated", () => {
    const feed = makeThreadViewFeed(() => 1)
    feed.publish({
      _tag: "SelectionLoaded",
      selectionEpoch: 1,
      activitySequence: 0,
      thread,
      entries: [],
      hasOlder: false,
      usage: { usage: ExecutionProjection.emptyUsageState() },
      queueRevision: 0,
      queue: [],
      activeTurn: turn,
    })
    feed.publish({
      _tag: "ExecutionProjectionChanged",
      threadId,
      turn,
      change: {
        _tag: "ProjectionSnapshot",
        revision: 1,
        checkpoint: { version: ExecutionProjection.projectionVersion, cursor: "private", state: "private" },
        units: [unit("first", "first"), unit("second", "second")],
        hasOlder: false,
        state: state(),
      },
    })
    const truncated = feed.publish({
      _tag: "ExecutionProjectionChanged",
      threadId,
      turn,
      change: {
        _tag: "ProjectionSnapshot",
        revision: 2,
        checkpoint: { version: ExecutionProjection.projectionVersion, cursor: "private", state: "private" },
        units: [unit("second", "second")],
        hasOlder: true,
        state: state(),
      },
    })
    const patch = truncated.find((value) => value._tag === "ThreadViewPatch")
    expect(patch).toMatchObject({ patch: { remove: [] } })
    expect(feed.current()?.turns[0]?.units.map((value) => value.key)).toContain("first")
  })

  it("keeps every delivered unit and cursor edge of a full snapshot beyond the old window bounds", () => {
    const feed = makeThreadViewFeed(() => 1)
    const pageEntry = (sequence: number) => ({
      turn,
      unit: {
        key: `unit:${sequence}`,
        turnId: String(turnId),
        order: [{ sequence, part: 0, key: `unit:${sequence}` }],
        revision: 1,
        content: { _tag: "Entry" as const, role: "assistant" as const, text: String(sequence) },
      },
      projectionRevision: 1,
      projectionModelPhase: -1,
      projectionState: state(),
    })
    const canonicalOldest = { createdAt: 1, turnId, orderKey: "canonical-oldest" }
    const canonicalNewest = { createdAt: 1, turnId, orderKey: "canonical-newest" }
    feed.publish({
      _tag: "SelectionLoaded",
      selectionEpoch: 1,
      activitySequence: 0,
      thread,
      entries: Array.from({ length: 150 }, (_, index) => pageEntry(index)),
      hasOlder: true,
      hasNewer: false,
      oldestCursor: canonicalOldest,
      newestCursor: canonicalNewest,
      usage: { usage: ExecutionProjection.emptyUsageState() },
      queueRevision: 0,
      queue: [],
    })
    expect(feed.current()?.source.oldestCursor).toEqual(canonicalOldest)
    expect(feed.current()?.source.newestCursor).toEqual(canonicalNewest)
    expect(feed.current()?.turns[0]?.units.map((value) => value.key)).toEqual(
      Array.from({ length: 150 }, (_, index) => `unit:${index}`),
    )
    expect(feed.current()?.hasOlder).toBe(true)
  })

  it("keeps the full ancestry-closed timeline of a large snapshot without evicting whole Turns", () => {
    const feed = makeThreadViewFeed(() => 1)
    const makeUnit = (key: string, sequence: number, parentId?: string) => ({
      key,
      turnId: String(turnId),
      order: [{ sequence, part: 0, key }],
      revision: 1,
      ...(parentId === undefined ? {} : { parentId }),
      content: { _tag: "Entry" as const, role: "assistant" as const, text: key },
    })
    const cardUnit = (key: string, sequence: number, name: string) => ({
      key,
      turnId: String(turnId),
      order: [{ sequence, part: 0, key }],
      revision: 1,
      content: {
        _tag: "Block" as const,
        block: {
          _tag: "SubagentCard" as const,
          id: `card-${name}`,
          name,
          prompt: name,
          promptTruncated: false,
          summary: "",
          status: "complete" as const,
          activity: [],
        },
      },
    })
    const newestUnits: Array<ReturnType<typeof makeUnit>> = [
      makeUnit("prompt", 0),
      makeUnit("root-reasoning", 1),
      cardUnit("task-card", 2, "Task"),
      ...Array.from({ length: 15 }, (_, index) => makeUnit(`task-child-${index}`, 3 + index, "card-Task")),
      cardUnit("librarian-card", 18, "Librarian"),
      ...Array.from({ length: 6 }, (_, index) => makeUnit(`librarian-child-${index}`, 19 + index, "card-Librarian")),
      cardUnit("review-card", 25, "Review"),
      ...Array.from({ length: 46 }, (_, index) => makeUnit(`review-child-${index}`, 26 + index, "card-Review")),
      cardUnit("review-retry-card", 72, "Review"),
      ...Array.from({ length: 52 }, (_, index) => makeUnit(`retry-child-${73 + index}`, 73 + index, "card-Review")),
    ]
    const entryFor = (entry: ReturnType<typeof makeUnit>) => ({
      turn,
      unit: entry,
      projectionRevision: 1,
      projectionModelPhase: -1,
      projectionState: state("completed"),
    })
    feed.publish({
      _tag: "SelectionLoaded",
      selectionEpoch: 1,
      activitySequence: 0,
      thread,
      entries: newestUnits.map((entry) => entryFor(entry)),
      hasOlder: false,
      hasNewer: false,
      usage: { usage: ExecutionProjection.emptyUsageState() },
      queueRevision: 0,
      queue: [],
    })
    const snapshot = feed.current()!
    const keys = snapshot.turns.flatMap((entry) => entry.units.map((value) => value.key))
    expect(keys).toHaveLength(newestUnits.length)
    for (const key of ["task-card", "librarian-card", "review-card", "review-retry-card", "prompt"])
      expect(keys).toContain(key)
    const parents = new Set(
      snapshot.turns
        .flatMap((entry) => entry.units)
        .filter((value) => value.content._tag === "Block")
        .flatMap((value) => (value.content.block._tag === "SubagentCard" ? [value.content.block.id] : [])),
    )
    for (const entry of snapshot.turns.flatMap((value) => value.units))
      if (entry.parentId !== undefined) expect(parents.has(entry.parentId)).toBe(true)
  })

  it("passes selected tentative previews without revising the durable ThreadView", () => {
    const feed = makeThreadViewFeed(() => 1)
    feed.publish({
      _tag: "SelectionLoaded",
      selectionEpoch: 1,
      activitySequence: 0,
      thread,
      entries: [],
      hasOlder: false,
      usage: { usage: ExecutionProjection.emptyUsageState() },
      queueRevision: 0,
      queue: [],
      activeTurn: turn,
    })
    const before = feed.current()
    const event = {
      _tag: "ExecutionModelPreviewChanged" as const,
      threadId,
      turnId,
      preview: {
        _tag: "ModelPreview" as const,
        runId: "run",
        attemptFence: 2,
        turn: 3,
        modelCallId: "call",
        modelAttemptId: "attempt",
        attempt: 4,
        sequence: 5,
        changes: [
          { channel: "reasoning" as const, offset: 0, delta: "thinking" },
          { channel: "text" as const, offset: 0, delta: "tentative" },
        ],
      },
    }
    expect(feed.publish(event)).toEqual([event])
    expect(feed.current()).toBe(before)
    expect(feed.publish({ ...event, threadId: Thread.ThreadId.make("other") })).toEqual([])
  })
})
