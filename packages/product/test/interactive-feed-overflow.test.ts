import { describe, expect, it } from "@effect/vitest"
import * as Thread from "@rika/product/thread-record"
import * as ThreadView from "@rika/product/thread-view"
import * as InteractiveFeedOverflow from "../src/operation/interactive/interactive-feed-overflow"

const threadId = Thread.ThreadId.make("thread")
const snapshot = (revision: number): ThreadView.ThreadViewSnapshot => ({
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
  revision,
  source: { projectionVersion: 1 },
  turns: [],
  pending: [],
  hasOlder: false,
})

const patch = (baseRevision: number, revision: number) => ({
  _tag: "ThreadViewPatch" as const,
  patch: { threadId, baseRevision, revision, upsert: [], remove: [], turnChanges: [] },
})

describe("interactive feed overflow", () => {
  it("collapses a patch storm into one typed resync per thread", () => {
    const state = InteractiveFeedOverflow.make()
    for (let revision = 1; revision <= 1_000; revision += 1)
      InteractiveFeedOverflow.remember(state, patch(revision - 1, revision))

    expect(state.criticalOverflowed).toBe(false)
    expect(InteractiveFeedOverflow.events(state)).toEqual([
      ThreadView.ResyncRequired.make({
        threadId,
        expectedRevision: 1_000,
        receivedBaseRevision: 999,
        currentRevision: 999,
      }),
    ])
  })

  it("retains an authoritative bounded snapshot instead of an earlier resync", () => {
    const state = InteractiveFeedOverflow.make()
    InteractiveFeedOverflow.remember(state, patch(0, 1))
    InteractiveFeedOverflow.remember(state, { _tag: "ThreadViewSnapshot", snapshot: snapshot(4) })
    expect(InteractiveFeedOverflow.events(state)).toEqual([{ _tag: "ThreadViewSnapshot", snapshot: snapshot(4) }])
  })

  it("keeps the newest bounded snapshot for a thread", () => {
    const state = InteractiveFeedOverflow.make()
    InteractiveFeedOverflow.remember(state, { _tag: "ThreadViewSnapshot", snapshot: snapshot(1) })
    InteractiveFeedOverflow.remember(state, { _tag: "ThreadViewSnapshot", snapshot: snapshot(2) })
    expect(InteractiveFeedOverflow.events(state)).toEqual([{ _tag: "ThreadViewSnapshot", snapshot: snapshot(2) }])
  })

  it("latches terminal overflow without growing past the bound", () => {
    const state = InteractiveFeedOverflow.make()
    for (let index = 0; index <= InteractiveFeedOverflow.capacity; index += 1)
      InteractiveFeedOverflow.remember(state, { _tag: "AssistantCompleted", text: String(index) })
    expect(state.criticalOverflowed).toBe(true)
    expect(state.critical).toHaveLength(InteractiveFeedOverflow.capacity)
  })
})
