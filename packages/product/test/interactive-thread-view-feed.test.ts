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
        checkpoint: { version: 1, cursor: "gateway:snapshot", state: "secret-state" },
        units: [unit("answer", "one")],
        hasOlder: false,
        state: state(),
      },
    })
    expect(started[0]).toMatchObject({
      _tag: "ThreadViewPatch",
      patch: { baseRevision: 0, revision: 1, header: { source: { projectionVersion: 1 } } },
    })

    const patched = feed.publish({
      _tag: "ExecutionProjectionChanged",
      threadId,
      turn: { ...turn, status: "completed" },
      change: {
        _tag: "ProjectionPatch",
        baseRevision: 0,
        revision: 1,
        checkpoint: { version: 1, cursor: "gateway:patch", state: "secret-state" },
        upsert: [unit("answer", "done")],
        remove: [],
        state: state("completed"),
      },
    })
    expect(patched[0]).toMatchObject({
      _tag: "ThreadViewPatch",
      patch: { baseRevision: 1, revision: 2, header: { source: { projectionVersion: 1 } } },
    })
    expect(JSON.stringify([...selected, ...started, ...patched])).not.toMatch(/gateway:|secret-state|checkpoint/)
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
        checkpoint: { version: 1, cursor: "gap", state: "gap" },
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
        checkpoint: { version: 1, cursor: "private", state: "private" },
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

  it("keeps off-window live projections out of a historical page without resyncing", () => {
    const feed = makeThreadViewFeed(() => 1)
    feed.publish({
      _tag: "SelectionLoaded",
      selectionEpoch: 1,
      activitySequence: 0,
      thread,
      entries: [],
      hasOlder: true,
      hasNewer: false,
      usage: { usage: ExecutionProjection.emptyUsageState() },
      queueRevision: 0,
      queue: [],
      activeTurn: turn,
    })
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
      _tag: "TranscriptPagePrepended",
      selectionEpoch: 1,
      threadId,
      entries: historyEntries,
      hasOlder: false,
    })
    expect(feed.current()?.hasNewer).toBe(true)
    expect(feed.current()?.turns.map((entry) => entry.turn.id)).toEqual([historyId])

    const live = feed.publish({
      _tag: "ExecutionProjectionChanged",
      threadId,
      turn,
      change: {
        _tag: "ProjectionPatch",
        baseRevision: 0,
        revision: 1,
        checkpoint: { version: 1, cursor: "private", state: "private" },
        upsert: [unit("answer", "live")],
        remove: [],
        state: state(),
      },
    })
    expect(live).toMatchObject([
      {
        _tag: "ThreadViewPatch",
        patch: { upsert: [], remove: [], turnChanges: [], header: { hasNewer: true } },
      },
    ])
    expect(feed.current()?.turns.map((entry) => entry.turn.id)).toEqual([historyId])
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
          checkpoint: { version: 1, cursor: "private", state: "private" },
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
          checkpoint: { version: 1, cursor: "private", state: "private" },
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
        checkpoint: { version: 1, cursor: "private", state: "private" },
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
        checkpoint: { version: 1, cursor: "private", state: "private" },
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
        checkpoint: { version: 1, cursor: "private", state: "private" },
        units: [unit("second", "second")],
        hasOlder: true,
        state: state(),
      },
    })
    const patch = truncated.find((value) => value._tag === "ThreadViewPatch")
    expect(patch).toMatchObject({ patch: { remove: [] } })
    expect(feed.current()?.turns[0]?.units.map((value) => value.key)).toContain("first")
  })

  it("preserves both page edges while walking backward and forward through a bounded window", () => {
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
    feed.publish({
      _tag: "SelectionLoaded",
      selectionEpoch: 1,
      activitySequence: 0,
      thread,
      entries: Array.from({ length: 100 }, (_, index) => pageEntry(index + 100)),
      hasOlder: true,
      hasNewer: false,
      oldestCursor: canonicalOldest,
      usage: { usage: ExecutionProjection.emptyUsageState() },
      queueRevision: 0,
      queue: [],
    })
    expect(feed.current()?.source.oldestCursor).toEqual(canonicalOldest)
    const prepended = feed.publish({
      _tag: "TranscriptPagePrepended",
      selectionEpoch: 1,
      threadId,
      entries: Array.from({ length: 50 }, (_, index) => pageEntry(index + 50)),
      hasOlder: true,
    })
    expect(prepended[0]).toMatchObject({
      _tag: "ThreadViewSnapshot",
      snapshot: { hasOlder: true, hasNewer: true },
    })
    expect(feed.current()?.turns[0]?.units.map((value) => value.key)).toEqual(
      Array.from({ length: 120 }, (_, index) => `unit:${index + 50}`),
    )
    expect(feed.current()?.source.oldestCursor?.turnId).toBe(turnId)
    expect(feed.current()?.source.newestCursor?.turnId).toBe(turnId)

    const requestedAfter = feed.current()?.source.newestCursor
    expect(requestedAfter).toBeDefined()
    const appended = feed.publish({
      _tag: "TranscriptPageAppended",
      selectionEpoch: 1,
      threadId,
      entries: Array.from({ length: 50 }, (_, index) => pageEntry(index + 170)),
      hasNewer: false,
      requestedAfter: requestedAfter!,
    })
    expect(appended[0]).toMatchObject({
      _tag: "ThreadViewSnapshot",
      snapshot: { hasOlder: true, hasNewer: false },
    })
    expect(feed.current()?.turns[0]?.units.map((value) => value.key)).toEqual(
      Array.from({ length: 120 }, (_, index) => `unit:${index + 100}`),
    )
  })

  it("never evicts a whole 125-unit Turn when an older page is prepended", () => {
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
    const olderUnit = (key: string, sequence: number) => ({
      ...makeUnit(key, sequence),
      turnId: "older-turn",
      order: [{ sequence, part: 0, key }],
    })
    const olderTurn: Turn.Turn = {
      ...turn,
      id: Turn.TurnId.make("older-turn"),
      createdAt: 0,
      updatedAt: 0,
    }
    const olderUnits = Array.from({ length: 5 }, (_, index) => olderUnit(`older-${index}`, index))
    const entryFor = (entry: ReturnType<typeof makeUnit>, unitTurn: Turn.Turn) => ({
      turn: unitTurn,
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
      entries: newestUnits.map((entry) => entryFor(entry, turn)),
      hasOlder: true,
      hasNewer: false,
      usage: { usage: ExecutionProjection.emptyUsageState() },
      queueRevision: 0,
      queue: [],
    })
    const prepended = feed.publish({
      _tag: "TranscriptPagePrepended",
      selectionEpoch: 1,
      threadId,
      entries: olderUnits.map((entry) => entryFor(entry, olderTurn)),
      hasOlder: false,
      oldestCursor: { createdAt: 0, turnId: "older-turn", orderKey: "older-0" },
    })
    expect(prepended[0]).toMatchObject({
      _tag: "ThreadViewSnapshot",
      snapshot: { hasOlder: false, hasNewer: true },
    })
    const afterPrepend = feed.current()!
    expect(afterPrepend.turns.map((entry) => entry.turn.id)).toContain(turn.id)
    const prependKeys = afterPrepend.turns.flatMap((entry) => entry.units.map((value) => value.key))
    expect(prependKeys).toHaveLength(120)
    for (const key of ["task-card", "librarian-card", "review-card", "review-retry-card"])
      expect(prependKeys).toContain(key)
    const prependParents = new Set(
      afterPrepend.turns
        .flatMap((entry) => entry.units)
        .filter((value) => value.content._tag === "Block")
        .flatMap((value) => (value.content.block._tag === "SubagentCard" ? [value.content.block.id] : [])),
    )
    for (const entry of afterPrepend.turns.flatMap((value) => value.units))
      if (entry.parentId !== undefined) expect(prependParents.has(entry.parentId)).toBe(true)

    const appended = feed.publish({
      _tag: "TranscriptPageAppended",
      selectionEpoch: 1,
      threadId,
      entries: newestUnits.slice(115).map((entry) => entryFor(entry, turn)),
      hasNewer: false,
      requestedAfter: afterPrepend.source.newestCursor!,
      newestCursor: { createdAt: 1, turnId: String(turnId), orderKey: "newest-124" },
    })
    expect(appended[0]).toMatchObject({
      _tag: "ThreadViewSnapshot",
      snapshot: { hasOlder: true, hasNewer: false },
    })
    const afterAppend = feed.current()!
    const appendKeys = afterAppend.turns.flatMap((entry) => entry.units.map((value) => value.key))
    expect(appendKeys).toHaveLength(120)
    for (const key of ["task-card", "librarian-card", "review-card", "review-retry-card"])
      expect(appendKeys).toContain(key)
    const appendParents = new Set(
      afterAppend.turns
        .flatMap((entry) => entry.units)
        .filter((value) => value.content._tag === "Block")
        .flatMap((value) => (value.content.block._tag === "SubagentCard" ? [value.content.block.id] : [])),
    )
    for (const entry of afterAppend.turns.flatMap((value) => value.units))
      if (entry.parentId !== undefined) expect(appendParents.has(entry.parentId)).toBe(true)
  })
})
