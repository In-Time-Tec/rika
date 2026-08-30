import { describe, expect, it } from "vitest"
import * as ExecutionProjection from "@rika/product/execution-projection"
import * as Thread from "@rika/product/thread-record"
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
    const makeUnit = (key: string, sequence: number, parentId?: string) => {
      const base = {
        key,
        turnId: String(turnId),
        order: [{ sequence, part: 0, key }],
        revision: 1,
        content: { _tag: "Entry" as const, role: "assistant" as const, text: key },
      }
      return parentId === undefined ? base : { ...base, parentId }
    }
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
    const parents = new Set<string>()
    for (const value of snapshot.turns.flatMap((entry) => entry.units)) {
      if (value.content._tag !== "Block") continue
      if (value.content.block._tag === "SubagentCard") parents.add(value.content.block.id)
    }
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
