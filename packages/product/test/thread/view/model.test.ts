import { describe, expect, it } from "@effect/vitest"
import { Result, Schema } from "effect"
import * as ThreadView from "../../../src/thread/view/model"
import * as ExecutionProjection from "@rika/product/execution-projection"

const thread = (id: string, title = "Thread") => ({
  id,
  workspace: "/workspace",
  title,
  labels: [],
  pinned: false,
  archived: false,
  lineage: { _tag: "Original" },
  createdAt: 1,
  updatedAt: 1,
})

const turn = (threadId: string, id: string, createdAt = 1) => ({
  kind: "shell",
  id,
  threadId,
  prompt: `$ ${id}`,
  command: id,
  author: { _tag: "Human" },
  lineage: { _tag: "Original" },
  status: "running",
  createdAt,
  updatedAt: createdAt,
})

const unit = (turnId: string, key: string, sequence: number, text = key) => ({
  key,
  turnId,
  order: [{ sequence, part: 0, key }],
  revision: 1,
  content: { _tag: "Entry", role: "assistant", text },
})

const pageCursor = (createdAt: number) => ({ createdAt, turnId: "turn", orderKey: `order:${createdAt}` })

const usageState = () => ExecutionProjection.emptyUsageState()
const usage = () => ({ state: usageState() })

const decodeSnapshot = <Input>(input: Input) => Schema.decodeUnknownSync(ThreadView.ThreadViewSnapshot)(input)
const decodePatch = <Input>(input: Input) => Schema.decodeUnknownSync(ThreadView.ThreadViewPatch)(input)

const snapshot = () =>
  decodeSnapshot({
    thread: thread("thread"),
    revision: 4,
    source: { projectionVersion: 2, oldestCursor: pageCursor(4), newestCursor: pageCursor(4) },
    turns: [
      {
        turn: turn("thread", "turn"),
        units: [unit("turn", "unit:1", 1)],
        projectionRevision: 1,
        usage: usageState(),
      },
    ],
    pending: [],
    hasOlder: true,
    hasNewer: false,
    usage: usage(),
  })

const apply = (
  current: ThreadView.ThreadViewSnapshot,
  change: ThreadView.ThreadViewPatch,
): Result.Result<ThreadView.ThreadViewSnapshot, ThreadView.ThreadViewApplyError> => {
  const hydrated = ThreadView.fromSnapshot(current)
  if (Result.isFailure(hydrated)) return hydrated
  const applied = hydrated.success.apply(change)
  return Result.isFailure(applied) ? applied : Result.succeed(hydrated.success.snapshot())
}

const patch = <Changes>(changes?: Changes) =>
  decodePatch({
    threadId: "thread",
    baseRevision: 4,
    revision: 5,
    upsert: [],
    remove: [],
    turnChanges: [],
    ...changes,
  })

describe("ThreadView contract", () => {
  it("decodes recovery snapshots and clears recovery on replacement and Turn removal", () => {
    const source = snapshot()
    const recovering = decodeSnapshot({
      ...source,
      turns: source.turns.map((entry) => ({ ...entry, needsResolution: true })),
    })
    const view = Result.getOrThrow(ThreadView.fromSnapshot(recovering))
    expect(view.turn("turn")?.needsResolution).toBe(true)
    const original = source.turns[0]!
    Result.getOrThrow(view.apply(patch({ turnChanges: [{ _tag: "UpsertTurn", ...original }] })))
    expect(view.turn("turn")?.needsResolution).toBe(false)
    const restored = Result.getOrThrow(ThreadView.fromSnapshot(recovering))
    Result.getOrThrow(
      restored.apply(patch({ turnChanges: [{ _tag: "RemoveTurn", turnId: "turn" }], remove: ["unit:1"] })),
    )
    expect(restored.turn("turn")).toBeUndefined()
    expect(restored.snapshot().turns).toEqual([])
  })

  it("round-trips a bounded read model without execution transport vocabulary", () => {
    const value = snapshot()
    const encoded = Schema.encodeSync(ThreadView.ThreadViewSnapshot)(value)
    expect(Schema.decodeSync(ThreadView.ThreadViewSnapshot)(encoded)).toEqual(value)
    expect(JSON.stringify(encoded)).not.toMatch(
      /selectionEpoch|executionId|executionLink|executionRoute|runId|streamId|origin|eventType/,
    )
  })

  it("rejects internally duplicated snapshots and accepts timelines beyond the old window bound", () => {
    const units = Array.from({ length: 300 }, (_, index) => unit("turn", `unit:${index}`, index))
    expect(() =>
      decodeSnapshot({
        thread: thread("thread"),
        revision: 0,
        source: { projectionVersion: 1 },
        turns: [{ turn: turn("thread", "turn"), units, projectionRevision: 0, usage: usageState() }],
        pending: [],
        hasOlder: false,
        hasNewer: false,
        usage: usage(),
      }),
    ).not.toThrow()
    expect(() =>
      decodeSnapshot({
        thread: thread("thread"),
        revision: 0,
        source: { projectionVersion: 1 },
        turns: [
          {
            turn: turn("thread", "turn"),
            units: [unit("turn", "same", 1), unit("turn", "same", 2)],
            projectionRevision: 0,
            usage: usageState(),
          },
        ],
        pending: [],
        hasOlder: false,
        hasNewer: false,
        usage: usage(),
      }),
    ).toThrow("duplicate timeline item same")
  })

  it("applies one exact patch immutably and keeps TranscriptUnit values as timeline items", () => {
    const current = snapshot()
    const change = patch({
      header: {
        thread: { ...thread("thread", "Renamed"), updatedAt: 5 },
        source: { projectionVersion: 2, oldestCursor: pageCursor(5), newestCursor: pageCursor(5) },
        pending: [{ id: "pending", prompt: "later", createdAt: 5 }],
        hasOlder: false,
        hasNewer: false,
        usage: usage(),
      },
      upsert: [{ ...unit("turn", "unit:1", 1, "updated"), revision: 2 }, unit("turn", "unit:2", 2)],
      turnChanges: [
        {
          _tag: "UpsertTurn",
          turn: { ...turn("thread", "turn"), updatedAt: 5 },
          projectionRevision: 2,
          usage: usageState(),
        },
      ],
    })

    const result = apply(current, change)
    expect(result._tag).toBe("Success")
    if (result._tag !== "Success") return
    expect(result.success).toMatchObject({
      revision: 5,
      thread: { id: "thread", title: "Renamed" },
      source: { projectionVersion: 2, oldestCursor: pageCursor(5), newestCursor: pageCursor(5) },
      hasOlder: false,
      hasNewer: false,
      usage: usage(),
      pending: [{ id: "pending", prompt: "later" }],
    })
    expect(result.success.turns[0]?.projectionRevision).toBe(2)
    expect(result.success.turns[0]?.units.map((item) => [item.key, item.content])).toEqual([
      ["unit:1", { _tag: "Entry", role: "assistant", text: "updated" }],
      ["unit:2", { _tag: "Entry", role: "assistant", text: "unit:2" }],
    ])
    expect(current.revision).toBe(4)
    expect(current.thread.title).toBe("Thread")
    expect(current.turns[0]?.units).toHaveLength(1)
  })

  it("adds and removes whole Turn views with the same reducer", () => {
    const current = snapshot()
    const result = apply(
      current,
      patch({
        remove: ["unit:1"],
        upsert: [unit("turn:new", "unit:new", 2)],
        turnChanges: [
          { _tag: "RemoveTurn", turnId: "turn" },
          { _tag: "UpsertTurn", turn: turn("thread", "turn:new", 2), projectionRevision: 1, usage: usageState() },
        ],
      }),
    )
    expect(result._tag).toBe("Success")
    if (result._tag === "Success") {
      expect(result.success.turns.map((entry) => entry.turn.id)).toEqual(["turn:new"])
      expect(result.success.turns[0]?.units.map((item) => item.key)).toEqual(["unit:new"])
    }
  })

  it("requires resync for stale bases and skipped revisions", () => {
    const stale = apply(snapshot(), patch({ baseRevision: 6, revision: 7 }))
    expect(stale).toMatchObject({
      _tag: "Failure",
      failure: {
        _tag: "ResyncRequired",
        threadId: "thread",
        expectedRevision: 5,
        receivedBaseRevision: 6,
        currentRevision: 4,
      },
    })
    const skipped = apply(snapshot(), patch({ revision: 6 }))
    expect(skipped).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "ResyncRequired", expectedRevision: 5, receivedBaseRevision: 4, currentRevision: 4 },
    })
  })

  it("rejects foreign and non-monotonic patches with closed errors", () => {
    expect(apply(snapshot(), patch({ threadId: "other" }))).toMatchObject({
      _tag: "Failure",
      failure: {
        _tag: "ThreadViewForeignThread",
        expectedThreadId: "thread",
        receivedThreadId: "other",
      },
    })
    expect(apply(snapshot(), patch({ revision: 4 }))).toMatchObject({
      _tag: "Failure",
      failure: {
        _tag: "ThreadViewNonMonotonicRevision",
        threadId: "thread",
        baseRevision: 4,
        revision: 4,
      },
    })
  })

  it("rejects duplicate, conflicting, missing, and orphan item changes", () => {
    const duplicate = unit("turn", "duplicate", 2)
    expect(apply(snapshot(), patch({ upsert: [duplicate, duplicate] }))).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "ThreadViewDuplicateItem", collection: "upsert", key: "duplicate" },
    })
    expect(apply(snapshot(), patch({ upsert: [unit("turn", "unit:1", 1)], remove: ["unit:1"] }))).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "ThreadViewInvalidPatch", reason: "conflicting-item-change", key: "unit:1" },
    })
    expect(apply(snapshot(), patch({ remove: ["missing"] }))).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "ThreadViewInvalidPatch", reason: "missing-item", key: "missing" },
    })
    expect(apply(snapshot(), patch({ upsert: [unit("missing-turn", "orphan", 2)] }))).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "ThreadViewInvalidPatch", reason: "missing-turn", key: "missing-turn" },
    })
    expect(apply(snapshot(), patch({ upsert: [{ ...unit("turn", "unit:1", 1), revision: 0 }] }))).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "ThreadViewInvalidPatch", reason: "unit-revision-regressed", key: "unit:1" },
    })
  })

  it("applies a tiny patch without reading or materializing the unrelated view", () => {
    let reads = 0
    const units = Array.from({ length: 10_000 }, (_, index) => {
      const value = unit("turn", `unit:${index}`, index)
      return new Proxy(value, {
        get(target, property) {
          reads += 1
          if (property === "key") return target.key
          if (property === "turnId") return target.turnId
          if (property === "order") return target.order
          if (property === "revision") return target.revision
          if (property === "content") return target.content
          return undefined
        },
      })
    })
    const baseSnapshot = snapshot()
    const [firstTurn, ...remainingTurns] = baseSnapshot.turns
    if (firstTurn === undefined) return
    const current: ThreadView.ThreadViewSnapshot = {
      ...baseSnapshot,
      turns: [{ ...firstTurn, units }, ...remainingTurns],
    }
    const hydrated = ThreadView.fromSnapshot(current)
    expect(hydrated._tag).toBe("Success")
    if (hydrated._tag !== "Success") return
    const unchangedTurn = hydrated.success.turn("turn")
    reads = 0
    const applied = hydrated.success.apply(
      patch({ upsert: [unit("turn", "unit:new", 10_001)], baseRevision: 4, revision: 5 }),
    )
    expect(applied._tag).toBe("Success")
    expect(reads).toBe(0)
    expect(hydrated.success.revision).toBe(5)
    expect(hydrated.success.turn("turn")).toBe(unchangedTurn)
    expect(reads).toBe(0)
    expect(hydrated.success.snapshot().turns[0]?.units).toHaveLength(10_001)
    expect(reads).toBeGreaterThan(0)
  })

  it("keeps the accumulator unchanged after an invalid transaction or revision gap", () => {
    const hydrated = ThreadView.fromSnapshot(snapshot())
    expect(hydrated._tag).toBe("Success")
    if (hydrated._tag !== "Success") return
    const before = hydrated.success.snapshot()
    const invalid = hydrated.success.apply(patch({ remove: ["unit:1"], upsert: [unit("missing-turn", "orphan", 2)] }))
    expect(invalid).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "ThreadViewInvalidPatch", reason: "missing-turn", key: "missing-turn" },
    })
    expect(hydrated.success.snapshot()).toBe(before)
    const gap = hydrated.success.apply(patch({ baseRevision: 5, revision: 6 }))
    expect(gap).toMatchObject({
      _tag: "Failure",
      failure: {
        _tag: "ResyncRequired",
        expectedRevision: 5,
        receivedBaseRevision: 5,
        currentRevision: 4,
      },
    })
    expect(hydrated.success.snapshot()).toBe(before)
    expect(hydrated.success.apply(patch())).toMatchObject({ _tag: "Success", success: { revision: 5 } })
  })

  it("round-trips every closed apply error through its schema", () => {
    const failures = [
      ThreadView.ResyncRequired.make({
        threadId: Schema.decodeSync(ThreadView.ThreadViewSnapshot)(snapshot()).thread.id,
        expectedRevision: 5,
        receivedBaseRevision: 6,
        currentRevision: 4,
      }),
      ThreadView.ThreadViewNonMonotonicRevision.make({
        threadId: snapshot().thread.id,
        baseRevision: 4,
        revision: 4,
      }),
      ThreadView.ThreadViewDuplicateItem.make({
        threadId: snapshot().thread.id,
        collection: "upsert",
        key: "unit",
      }),
    ]
    for (const failure of failures) {
      const encoded = Schema.encodeSync(ThreadView.ThreadViewApplyError)(failure)
      expect(Schema.decodeSync(ThreadView.ThreadViewApplyError)(encoded)).toEqual(failure)
    }
  })
})
