import { describe, expect, it } from "vitest"
import * as Thread from "@rika/product/thread-record"
import * as Turn from "@rika/product/turn-record"
import * as ThreadView from "@rika/product/thread-view"
import * as ExecutionProjection from "@rika/product/execution-projection"
import * as Overflow from "../src/transport/host/server-host-feed-overflow"

const threadId = Thread.ThreadId.make("thread")
const turnId = Turn.TurnId.make("turn")
const preview = (revision: number, runId = "run") => ({
  _tag: "ExecutionModelPreviewChanged" as const,
  threadId,
  turnId,
  preview: {
    _tag: "ModelPreview" as const,
    runId,
    attemptFence: 1,
    turn: 0,
    modelCallId: "call",
    modelAttemptId: "attempt",
    attempt: 0,
    sequence: revision,
    changes: [{ channel: "text" as const, offset: revision, delta: String(revision) }] as const,
  },
})

describe("server host preview overflow", () => {
  it("coalesces preview storms to one scoped invalidation while retaining control outcomes", () => {
    const state = Overflow.make()
    for (let revision = 1; revision <= 10_000; revision += 1) Overflow.remember(state, preview(revision))
    const controlled = { _tag: "ExecutionControlled" as const, threadId, turnId, action: "cancelled" as const }
    Overflow.remember(state, controlled)
    expect(state.degraded).toBeUndefined()
    expect(Overflow.events(state)).toEqual([
      controlled,
      {
        ...preview(10_000),
        preview: { _tag: "ModelPreviewCleared", runId: "run", attemptFence: 1, generation: 0 },
      },
    ])
  })

  it("retains one invalidation for each concurrently streaming run", () => {
    const state = Overflow.make()
    Overflow.remember(state, preview(1, "child-a"))
    Overflow.remember(state, preview(1, "child-b"))

    expect(
      Overflow.events(state).map((event) =>
        event._tag === "ExecutionModelPreviewChanged" ? event.preview.runId : event._tag,
      ),
    ).toEqual(["child-a", "child-b"])
  })
})

it("preserves the thread resync when a control event follows a lost patch", () => {
  const state = Overflow.make()
  // Fill the view capacity with distinct threads so the next view event degrades the state.
  for (let index = 0; index < 64; index += 1)
    Overflow.remember(state, {
      _tag: "ThreadViewPatch",
      patch: {
        threadId: Thread.ThreadId.make(`t${index}`),
        baseRevision: 0,
        revision: 1,
        upsert: [],
        remove: [],
        turnChanges: [],
      },
    })
  Overflow.remember(state, {
    _tag: "ThreadViewPatch",
    patch: {
      threadId: Thread.ThreadId.make("overflowed"),
      baseRevision: 0,
      revision: 1,
      upsert: [],
      remove: [],
      turnChanges: [],
    },
  })
  expect(state.degraded).toBeDefined()
  // A control event arriving after the lost patch must not replace the recovery resync.
  Overflow.remember(state, { _tag: "ExecutionControlled", threadId, turnId, action: "cancelled" })
  const recovered = Overflow.events(state)
  expect(recovered).toHaveLength(1)
  expect(recovered[0]?._tag).toBe("ResyncRequired")
})

describe("server host ThreadView overflow", () => {
  const snapshot = (): ThreadView.ThreadViewSnapshot => ({
    thread: {
      id: threadId,
      workspace: "/workspace",
      title: "Thread",
      labels: [],
      pinned: false,
      archived: false,
      lineage: { _tag: "Original" },
      createdAt: 1,
      updatedAt: 1,
    },
    source: { projectionVersion: 1 },
    revision: 0,
    turns: [
      {
        turn: {
          kind: "shell",
          id: turnId,
          threadId,
          prompt: "echo test",
          command: "echo test",
          author: { _tag: "Human" },
          lineage: { _tag: "Original" },
          status: "running",
          createdAt: 1,
          updatedAt: 1,
        },
        projectionRevision: 0,
        usage: ExecutionProjection.emptyUsageState(),
        units: [],
      },
    ],
    pending: [],
    hasOlder: false,
    hasNewer: false,
    usage: { state: ExecutionProjection.emptyUsageState() },
  })

  it("accumulates exact patches and materializes only when drained", () => {
    const state = Overflow.make()
    Overflow.remember(state, { _tag: "ThreadViewSnapshot", snapshot: snapshot() })
    for (let revision = 1; revision <= 1_000; revision += 1)
      Overflow.remember(state, {
        _tag: "ThreadViewPatch",
        patch: {
          threadId,
          baseRevision: revision - 1,
          revision,
          upsert: [
            {
              key: `unit:${revision}`,
              turnId: String(turnId),
              order: [{ sequence: revision, part: 0, key: `unit:${revision}` }],
              revision: 1,
              content: { _tag: "Entry", role: "assistant", text: String(revision) },
            },
          ],
          remove: [],
          turnChanges: [],
        },
      })
    const buffered = state.views.get(String(threadId))
    expect(buffered?._tag).toBe("ThreadViewAccumulator")
    const drained = Overflow.events(state)
    expect(drained).toHaveLength(1)
    expect(drained[0]).toMatchObject({
      _tag: "ThreadViewSnapshot",
      snapshot: {
        revision: 1_000,
        turns: [{ units: expect.arrayContaining([expect.objectContaining({ key: "unit:1000" })]) }],
      },
    })
  })

  it("requires resync instead of emitting a skipped-revision merged patch", () => {
    const state = Overflow.make()
    Overflow.remember(state, {
      _tag: "ThreadViewPatch",
      patch: { threadId, baseRevision: 0, revision: 1, upsert: [], remove: [], turnChanges: [] },
    })
    Overflow.remember(state, {
      _tag: "ThreadViewPatch",
      patch: { threadId, baseRevision: 1, revision: 2, upsert: [], remove: [], turnChanges: [] },
    })
    expect(Overflow.events(state)).toMatchObject([
      { _tag: "ResyncRequired", threadId, expectedRevision: 2, receivedBaseRevision: 1, currentRevision: 1 },
    ])
  })
})
