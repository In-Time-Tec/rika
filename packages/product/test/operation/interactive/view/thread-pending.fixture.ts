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
  it("keeps pending turns in canonical FIFO order across snapshots and middle restoration", () => {
    const feed = makeThreadViewFeed(() => 1)
    feed.publish({
      _tag: "SelectionLoaded",
      selectionEpoch: 1,
      activitySequence: 0,
      thread,
      entries: [],
      hasOlder: false,
      usage: { usage: ExecutionProjection.emptyUsageState() },
      queueRevision: 1,
      queue: [
        { id: Turn.TurnId.make("head"), prompt: "head", createdAt: 1 },
        { id: Turn.TurnId.make("tail"), prompt: "tail", createdAt: 3 },
      ],
    })
    expect(feed.current()?.pending.map((item) => item.id)).toEqual(["head", "tail"])

    feed.publish({
      _tag: "QueueUpdated",
      selectionEpoch: 1,
      threadId,
      revision: 2,
      queuedCount: 3,
      change: {
        _tag: "Added",
        position: 1,
        item: { id: Turn.TurnId.make("middle"), prompt: "middle", createdAt: 2 },
      },
    })
    expect(feed.current()?.pending.map((item) => item.id)).toEqual(["head", "middle", "tail"])
  })

  it("never regresses a settled Turn when delayed lifecycle events arrive", () => {
    const feed = makeThreadViewFeed(() => 2)
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
      _tag: "TurnSettled",
      selectionEpoch: 1,
      activitySequence: 2,
      threadId,
      turnId,
      status: "completed",
    })
    feed.publish({
      _tag: "ExecutionProjectionChanged",
      threadId,
      turn,
      change: {
        _tag: "ProjectionSnapshot",
        revision: 0,
        checkpoint: {
          version: ExecutionProjection.projectionVersion,
          cursor: "delayed",
          state: "delayed",
        },
        units: [unit("delayed", "late")],
        hasOlder: false,
        state: state("running"),
      },
    })
    expect(feed.current()?.turns[0]?.turn.status).toBe("completed")

    const reordered = makeThreadViewFeed(() => 2)
    reordered.publish({
      _tag: "SelectionLoaded",
      selectionEpoch: 1,
      activitySequence: 0,
      thread,
      entries: [],
      hasOlder: false,
      usage: { usage: ExecutionProjection.emptyUsageState() },
      queueRevision: 0,
      queue: [],
    })
    reordered.publish({
      _tag: "TurnSettled",
      selectionEpoch: 1,
      activitySequence: 2,
      threadId,
      turnId,
      status: "completed",
    })
    reordered.publish({
      _tag: "TurnStarted",
      selectionEpoch: 1,
      activitySequence: 1,
      threadId,
      turn,
    })
    expect(reordered.current()?.turns[0]?.turn.status).toBe("completed")
  })

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
    const selectedEvent = selected[0]
    if (selectedEvent?._tag !== "ThreadViewSnapshot") return
    const snapshot = selectedEvent.snapshot
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
    expect(feed.checkpoint(String(turnId))).toBeUndefined()
    expect(feed.publish({ _tag: "ThreadTitled", threadId: String(threadId), title: "ignored" })).toEqual([])
  })

  it("requires a durable checkpoint before publishing a pending authorization", () => {
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
    expect(
      feed.publish({
        _tag: "ExecutionProjectionChanged",
        threadId,
        turn: { ...turn, status: "waiting" },
        change: {
          _tag: "ProjectionSnapshot",
          revision: 0,
          units: [
            {
              key: "authorization:1",
              turnId: String(turnId),
              order: [{ sequence: 0, part: 0, key: "authorization:1" }],
              revision: 1,
              content: {
                _tag: "Block",
                block: {
                  _tag: "AuthorizationCard",
                  id: "authorization-1",
                  operation: "write",
                  capability: "workspace",
                  input: '{"path":"README.md"}',
                  inputTruncated: false,
                  status: "pending",
                },
              },
            },
          ],
          hasOlder: false,
          state: state("waiting"),
        },
      }),
    ).toMatchObject([{ _tag: "ResyncRequired", threadId }])
    expect(feed.current()?.turns[0]?.units.some((candidate) => candidate.key === "authorization:1")).toBe(false)
    expect(feed.checkpoint(String(turnId))).toBeUndefined()
  })
})
