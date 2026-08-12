import * as ExecutionProjection from "@rika/product/execution-projection"
import { describe, expect, it } from "@effect/vitest"
import * as Thread from "@rika/product/thread-record"
import * as Turn from "@rika/product/turn-record"
import * as ExecutionRouteSnapshot from "@rika/product/execution-route-snapshot"
import * as LiveThreadProjection from "../src/thread/projection/live-thread-projection"
import { makeThreadViewFeed } from "../src/operation/interactive/interactive-thread-view-feed"
import { hubFrameEvent } from "../src/operation/interactive/interactive-selection-projection"
import * as ThreadView from "../src/thread/model/thread-view"
import { Effect, Fiber, Stream } from "effect"
import type { InteractiveEvent as RuntimeEvent } from "../src/operation/interactive/interactive-runtime-event"

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

const selectedEvent = (
  overrides: Partial<Extract<RuntimeEvent, { readonly _tag: "SelectionLoaded" }>> = {},
): RuntimeEvent =>
  ({
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
    ...overrides,
  }) as RuntimeEvent

const viewAfter = (
  snapshotEvent: { readonly _tag: "ThreadViewSnapshot" } | undefined,
  patches: ReadonlyArray<
    Extract<
      import("../src/operation/interactive/interactive-event").InteractiveEvent,
      { readonly _tag: "ThreadViewPatch" }
    >
  >,
) => {
  let current =
    snapshotEvent !== undefined && snapshotEvent._tag === "ThreadViewSnapshot"
      ? (snapshotEvent as { snapshot: ThreadView.ThreadViewSnapshot }).snapshot
      : undefined
  for (const patch of patches) {
    if (current === undefined) break
    const applied = ThreadView.apply(current, patch.patch)
    if (applied._tag === "Success") current = applied.success
  }
  return current
}

const drive = (
  hub: LiveThreadProjection.Interface,
  id: Thread.ThreadId,
  body: (publish: (event: RuntimeEvent) => void) => Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    const frames: Array<LiveThreadProjection.HubFrame> = []
    const collector = yield* Effect.forkChild(
      Stream.runForEach(hub.watch(id), (frame) => Effect.sync(() => frames.push(frame))),
    )
    const feed = makeThreadViewFeed(hub)
    const waitForFrames = (count: number, tries = 0): Effect.Effect<void> =>
      Effect.suspend(() =>
        frames.length >= count || tries > 10_000
          ? Effect.void
          : Effect.yieldNow.pipe(Effect.andThen(waitForFrames(count, tries + 1))),
      )
    yield* waitForFrames(1)
    yield* body((event) => {
      if (event._tag === "ExecutionProjectionChanged" && event.turn !== undefined)
        hub.commitChange(event.threadId, event.turn, event.change)
      feed.publish(event)
    })
    const yieldMany = (count: number): Effect.Effect<void> =>
      count === 0 ? Effect.void : Effect.yieldNow.pipe(Effect.andThen(yieldMany(count - 1)))
    const waitForStable = (tries = 0): Effect.Effect<void> =>
      Effect.suspend(() => {
        const before = frames.length
        return yieldMany(8).pipe(
          Effect.andThen(
            Effect.suspend(() => (frames.length === before || tries > 500 ? Effect.void : waitForStable(tries + 1))),
          ),
        )
      })
    yield* waitForStable()
    yield* Fiber.interrupt(collector).pipe(Effect.ignore)
    const translated = frames.flatMap((frame) => feed.publish(hubFrameEvent(threadId, frame)))
    return { translated, frames }
  })

describe("interactive ThreadView feed", () => {
  it.effect("maps direct Projection Changes without exposing gateway checkpoints", () =>
    Effect.gen(function* () {
      const hub = yield* LiveThreadProjection.make(() => 1)
      const result = yield* drive(hub, threadId, (publish) =>
        Effect.sync(() => {
          publish(selectedEvent({ activeTurn: turn }))
          publish({
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
          publish({
            _tag: "ExecutionProjectionChanged",
            threadId,
            turn: { ...turn, status: "completed" },
            change: {
              _tag: "ProjectionPatch",
              baseRevision: 0,
              revision: 1,
              checkpoint: {
                version: ExecutionProjection.projectionVersion,
                cursor: "gateway:patch",
                state: "secret-state",
              },
              upsert: [unit("answer", "done")],
              remove: [],
              state: state("completed"),
            },
          })
        }),
      )
      const patches = result.translated.filter((event) => event._tag === "ThreadViewPatch")
      expect(patches[0]).toMatchObject({
        _tag: "ThreadViewPatch",
        patch: { baseRevision: 0, revision: 1, header: { source: { projectionVersion: 2 } } },
      })
      expect(patches[1]).toMatchObject({
        _tag: "ThreadViewPatch",
        patch: { baseRevision: 1, revision: 2, header: { source: { projectionVersion: 2 } } },
      })
      const flatten = (value: unknown): string =>
        typeof value === "object" && value !== null
          ? Object.values(value as Record<string, unknown>)
              .map(flatten)
              .join(",")
          : String(value)
      expect(flatten(result.translated)).not.toMatch(/gateway:|secret-state|checkpoint/)
    }),
  )

  it.effect("carries the first turn's prompt unit in the created-thread base snapshot", () =>
    Effect.gen(function* () {
      const hub = yield* LiveThreadProjection.make(() => 1)
      const result = yield* drive(hub, threadId, (publish) =>
        Effect.sync(() => publish(selectedEvent({ activeTurn: { ...turn, status: "accepted" } }))),
      )
      const snapshotEvent = result.translated.find((event) => event._tag === "ThreadViewSnapshot")
      expect(snapshotEvent).toBeDefined()
      const units =
        snapshotEvent?._tag === "ThreadViewSnapshot" ? snapshotEvent.snapshot.turns.flatMap((entry) => entry.units) : []
      expect(units).toContainEqual({
        key: "turn:turn:user",
        turnId: "turn",
        order: [{ sequence: -1, part: 0, key: "turn:turn:user" }],
        revision: 0,
        content: { _tag: "Entry", role: "user", text: "prompt" },
      })
    }),
  )

  it.effect("emits typed resync and stops patching after a projection revision gap", () =>
    Effect.gen(function* () {
      const hub = yield* LiveThreadProjection.make(() => 1)
      const result = yield* drive(hub, threadId, (publish) =>
        Effect.sync(() => {
          publish(selectedEvent({ activeTurn: turn }))
          publish({
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
          // After the generation invalidation the base is gone, so further changes are dropped
          // until a fresh selection rebuilds it.
          publish({
            _tag: "ExecutionProjectionChanged",
            threadId,
            turn,
            change: {
              _tag: "ProjectionSnapshot",
              revision: 11,
              units: [unit("answer", "late")],
              hasOlder: false,
              state: state(),
            },
          })
        }),
      )
      expect(result.translated.some((event) => event._tag === "ThreadViewSnapshot")).toBe(true)
      expect(result.frames.some((frame) => frame._tag === "Generation" && frame.generation === 3)).toBe(true)
      expect(result.translated.some((event) => event._tag === "ResyncRequired")).toBe(true)
      expect(result.translated.some((event) => event._tag === "ThreadViewPatch")).toBe(false)
    }),
  )

  it.effect("updates closed aggregate usage atomically in the same ThreadView patch", () =>
    Effect.gen(function* () {
      const hub = yield* LiveThreadProjection.make(() => 1)
      const result = yield* drive(hub, threadId, (publish) =>
        Effect.sync(() => {
          publish(
            selectedEvent({
              activeTurn: turn,
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
            }),
          )
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
          publish({
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
          publish({
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
              state: {
                status: "completed",
                usage: secondUsage,
                steering: { steeringMessages: 0, followUpMessages: 0 },
              },
            },
          })
        }),
      )
      const patches = result.translated.filter((event) => event._tag === "ThreadViewPatch")
      expect(patches[0]).toMatchObject({
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
      })
      const snapshotEvent = result.translated.find((event) => event._tag === "ThreadViewSnapshot")
      let current: ThreadView.ThreadViewSnapshot | undefined =
        snapshotEvent !== undefined && snapshotEvent._tag === "ThreadViewSnapshot" ? snapshotEvent.snapshot : undefined
      for (const patch of patches) {
        if (current === undefined) break
        const applied = ThreadView.apply(current, patch.patch)
        if (applied._tag === "Success") current = applied.success
      }
      expect(current?.usage.state).toMatchObject({
        costNanoUsd: 175,
        tokens: { total: 22, input: { total: 15, cacheRead: 3 }, output: { total: 7, reasoning: 1 } },
        pricedAttempts: 3,
        countedAttempts: 3,
        active: { _tag: "Available", accumulatedMillis: 65 },
      })
      const flatten = (value: unknown): string =>
        typeof value === "object" && value !== null
          ? Object.values(value as Record<string, unknown>)
              .map(flatten)
              .join(",")
          : String(value)
      expect(flatten(result.translated)).not.toMatch(/modelCallId|modelAttemptId|raw-root|private/)
    }),
  )

  it.effect("delivers every unit of a full snapshot without re-bounding the timeline", () =>
    Effect.gen(function* () {
      const hub = yield* LiveThreadProjection.make(() => 1)
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
      const result = yield* drive(hub, threadId, (publish) =>
        Effect.sync(() => {
          publish(selectedEvent({ entries: historyEntries, activeTurn: turn }))
          publish({
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
        }),
      )
      const snapshotEvent = result.translated.find((event) => event._tag === "ThreadViewSnapshot")
      expect(snapshotEvent?._tag === "ThreadViewSnapshot" ? snapshotEvent.snapshot.hasNewer : undefined).toBe(false)
      expect(
        snapshotEvent?._tag === "ThreadViewSnapshot" ? snapshotEvent.snapshot.turns.map((entry) => entry.turn.id) : [],
      ).toEqual([historyId, turn.id])
      expect(snapshotEvent?._tag === "ThreadViewSnapshot" ? snapshotEvent.snapshot.turns[0]?.units : []).toHaveLength(
        130,
      )
      expect(result.translated).toMatchObject([
        { _tag: "ThreadViewSnapshot" },
        { _tag: "ThreadViewPatch", patch: { upsert: [{ content: { text: "live" } }] } },
      ])
    }),
  )

  it.effect("resyncs an unknown turn ahead of a historical window instead of dropping its units", () =>
    Effect.gen(function* () {
      const hub = yield* LiveThreadProjection.make(() => 1)
      const newTurn: Turn.Turn = { ...turn, id: Turn.TurnId.make("new-recorded-shell"), createdAt: 2, updatedAt: 2 }
      const result = yield* drive(hub, threadId, (publish) =>
        Effect.sync(() => {
          publish(
            selectedEvent({
              entries: [
                {
                  turn,
                  unit: unit("history", "history"),
                  projectionRevision: 1,
                  projectionModelPhase: -1,
                  projectionState: state("completed"),
                },
              ],
              hasNewer: true,
            }),
          )
          publish({
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
          })
        }),
      )
      expect(result.frames.some((frame) => frame._tag === "Generation")).toBe(true)
      expect(result.translated.some((event) => event._tag === "ResyncRequired")).toBe(true)
    }),
  )

  it.effect("inserts a new snapshot turn directly at the live tail", () =>
    Effect.gen(function* () {
      const hub = yield* LiveThreadProjection.make(() => 1)
      const newTurn: Turn.Turn = {
        ...turn,
        id: Turn.TurnId.make("new-recorded-shell-live"),
        createdAt: 2,
        updatedAt: 2,
      }
      const result = yield* drive(hub, threadId, (publish) =>
        Effect.sync(() => {
          publish(selectedEvent())
          publish({
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
          })
        }),
      )
      const patch = result.translated.find((event) => event._tag === "ThreadViewPatch")
      expect(patch).toMatchObject({
        patch: {
          upsert: [
            { key: `turn:${newTurn.id}:user`, content: { _tag: "Entry", role: "user", text: "prompt" } },
            { content: { text: "ALLOWED" } },
          ],
        },
      })
      const snapshotEvent = result.translated.find((event) => event._tag === "ThreadViewSnapshot")
      const current = viewAfter(
        snapshotEvent,
        result.translated.filter(
          (
            event,
          ): event is Extract<
            import("../src/operation/interactive/interactive-event").InteractiveEvent,
            { readonly _tag: "ThreadViewPatch" }
          > => event._tag === "ThreadViewPatch",
        ),
      )
      expect(current?.turns.map((entry) => entry.turn.id)).toEqual([newTurn.id])
    }),
  )

  it.effect("keeps every unit of one large turn instead of amputating its oldest units", () =>
    Effect.gen(function* () {
      const hub = yield* LiveThreadProjection.make(() => 1)
      const units = Array.from({ length: 200 }, (_, index) => unit(`subagent:${index}`, String(index)))
      const result = yield* drive(hub, threadId, (publish) =>
        Effect.sync(() => {
          publish(selectedEvent({ activeTurn: turn }))
          publish({
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
        }),
      )
      expect(result.translated.some((event) => event._tag === "ResyncRequired")).toBe(false)
      const snapshotEvent = result.translated.find((event) => event._tag === "ThreadViewSnapshot")
      const current = viewAfter(
        snapshotEvent,
        result.translated.filter(
          (
            event,
          ): event is Extract<
            import("../src/operation/interactive/interactive-event").InteractiveEvent,
            { readonly _tag: "ThreadViewPatch" }
          > => event._tag === "ThreadViewPatch",
        ),
      )
      expect(current?.turns[0]?.units.map((value) => value.key)).toContain("subagent:0")
      // The prompt seed belongs to the view and is never amputated by a projection snapshot.
      expect(current?.turns[0]?.units).toHaveLength(201)
    }),
  )

  it.effect("does not remove previously shown units when a snapshot is itself truncated", () =>
    Effect.gen(function* () {
      const hub = yield* LiveThreadProjection.make(() => 1)
      const result = yield* drive(hub, threadId, (publish) =>
        Effect.sync(() => {
          publish(selectedEvent({ activeTurn: turn }))
          publish({
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
          publish({
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
        }),
      )
      const patches = result.translated.filter((event) => event._tag === "ThreadViewPatch")
      expect(patches.at(-1)).toMatchObject({ patch: { remove: [] } })
      const snapshotEvent = result.translated.find((event) => event._tag === "ThreadViewSnapshot")
      const current = viewAfter(
        snapshotEvent,
        result.translated.filter(
          (
            event,
          ): event is Extract<
            import("../src/operation/interactive/interactive-event").InteractiveEvent,
            { readonly _tag: "ThreadViewPatch" }
          > => event._tag === "ThreadViewPatch",
        ),
      )
      expect(current?.turns[0]?.units.map((value) => value.key)).toContain("first")
    }),
  )

  it.effect("keeps every delivered unit and cursor edge of a full snapshot beyond the old window bounds", () =>
    Effect.gen(function* () {
      const hub = yield* LiveThreadProjection.make(() => 1)
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
      const result = yield* drive(hub, threadId, (publish) =>
        Effect.sync(() =>
          publish(
            selectedEvent({
              entries: Array.from({ length: 150 }, (_, index) => pageEntry(index)),
              hasOlder: true,
              oldestCursor: canonicalOldest,
              newestCursor: canonicalNewest,
            }),
          ),
        ),
      )
      const snapshotEvent = result.translated.find((event) => event._tag === "ThreadViewSnapshot")
      if (snapshotEvent === undefined || snapshotEvent._tag !== "ThreadViewSnapshot")
        return yield* Effect.die("missing base")
      expect(snapshotEvent.snapshot.source.oldestCursor).toEqual(canonicalOldest)
      expect(snapshotEvent.snapshot.source.newestCursor).toEqual(canonicalNewest)
      expect(snapshotEvent.snapshot.turns[0]?.units.map((value) => value.key)).toEqual(
        Array.from({ length: 150 }, (_, index) => `unit:${index}`),
      )
      expect(snapshotEvent.snapshot.hasOlder).toBe(true)
    }),
  )

  it.effect("keeps the full ancestry-closed timeline of a large snapshot without evicting whole Turns", () =>
    Effect.gen(function* () {
      const hub = yield* LiveThreadProjection.make(() => 1)
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
      const result = yield* drive(hub, threadId, (publish) =>
        Effect.sync(() => publish(selectedEvent({ entries: newestUnits.map((entry) => entryFor(entry)) }))),
      )
      const snapshotEvent = result.translated.find((event) => event._tag === "ThreadViewSnapshot")
      if (snapshotEvent === undefined || snapshotEvent._tag !== "ThreadViewSnapshot")
        return yield* Effect.die("missing base")
      const snapshot = snapshotEvent.snapshot
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
    }),
  )

  it.effect("passes selected tentative previews without revising the durable ThreadView", () =>
    Effect.gen(function* () {
      const hub = yield* LiveThreadProjection.make(() => 1)
      const preview = {
        _tag: "ModelPreviewed" as const,
        key: {
          runId: "run",
          attemptFence: 2,
          turn: 3,
          modelCallId: "call",
          modelAttemptId: "attempt",
          attempt: 4,
        },
        revision: 5,
        text: "tentative",
        reasoning: "thinking",
        truncated: false,
      }
      const result = yield* drive(hub, threadId, (publish) =>
        Effect.sync(() => {
          publish(selectedEvent({ activeTurn: turn }))
          hub.preview(threadId, turnId, preview)
        }),
      )
      const previewEvent = result.translated.find((event) => event._tag === "ExecutionModelPreviewed")
      expect(previewEvent).toMatchObject({ threadId, turnId, preview })
      expect(result.translated.some((event) => event._tag === "ThreadViewSnapshot")).toBe(true)
    }),
  )
})
