import * as ExecutionGateway from "@rika/product/execution-gateway"
import * as ExecutionProjection from "@rika/product/execution-projection"
import * as Thread from "@rika/product/thread-record"
import * as ThreadView from "@rika/product/thread-view"
import * as Turn from "@rika/product/turn-record"
import { Effect, PubSub, Result, Stream } from "effect"
import { promptUnit } from "../../operation/interactive/interactive-prompt-unit"

const pending = (
  items: ReadonlyArray<{ readonly id: Turn.TurnId; readonly prompt: string; readonly createdAt: number }>,
): ReadonlyArray<ThreadView.ThreadViewPendingTurn> =>
  items.slice(0, ThreadView.limits.pending).map((item) => ({
    id: item.id,
    prompt: item.prompt,
    createdAt: item.createdAt,
  }))

const trackedProjectionLimit = 64

const difference = (next: number | undefined, previous: number | undefined): number | undefined => {
  if (next === undefined) return previous === undefined ? undefined : 0
  return Math.max(0, next - (previous ?? 0))
}

const tokenDifference = (
  next: ExecutionProjection.TokenTotals | undefined,
  previous: ExecutionProjection.TokenTotals | undefined,
): ExecutionProjection.TokenTotals | undefined => {
  if (next === undefined) return undefined
  return {
    ...(difference(next.total, previous?.total) === undefined
      ? {}
      : { total: difference(next.total, previous?.total)! }),
    input: {
      ...(difference(next.input.total, previous?.input.total) === undefined
        ? {}
        : { total: difference(next.input.total, previous?.input.total)! }),
      ...(difference(next.input.uncached, previous?.input.uncached) === undefined
        ? {}
        : { uncached: difference(next.input.uncached, previous?.input.uncached)! }),
      ...(difference(next.input.cacheRead, previous?.input.cacheRead) === undefined
        ? {}
        : { cacheRead: difference(next.input.cacheRead, previous?.input.cacheRead)! }),
    },
    output: {
      ...(difference(next.output.total, previous?.output.total) === undefined
        ? {}
        : { total: difference(next.output.total, previous?.output.total)! }),
      ...(difference(next.output.text, previous?.output.text) === undefined
        ? {}
        : { text: difference(next.output.text, previous?.output.text)! }),
      ...(difference(next.output.reasoning, previous?.output.reasoning) === undefined
        ? {}
        : { reasoning: difference(next.output.reasoning, previous?.output.reasoning)! }),
    },
    ...(difference(next.failedProviderTotal, previous?.failedProviderTotal) === undefined
      ? {}
      : { failedProviderTotal: difference(next.failedProviderTotal, previous?.failedProviderTotal)! }),
  }
}

const nextThreadUsage = (
  current: ThreadView.ThreadViewUsage,
  previous: ExecutionProjection.UsageState | undefined,
  next: ExecutionProjection.UsageState,
  turn: import("@rika/product/turn-record").Turn | undefined,
): ThreadView.ThreadViewUsage => {
  const previousActive = previous?.active._tag === "Available" ? previous.active.accumulatedMillis : 0
  const nextActive = next.active._tag === "Available" ? next.active.accumulatedMillis : 0
  const costNanoUsd = difference(next.costNanoUsd, previous?.costNanoUsd)
  const delta: ExecutionProjection.UsageState = {
    ...(costNanoUsd === undefined ? {} : { costNanoUsd }),
    ...(tokenDifference(next.tokens, previous?.tokens) === undefined
      ? {}
      : { tokens: tokenDifference(next.tokens, previous?.tokens)! }),
    pricedAttempts: Math.max(0, next.pricedAttempts - (previous?.pricedAttempts ?? 0)),
    unpricedAttempts: Math.max(0, next.unpricedAttempts - (previous?.unpricedAttempts ?? 0)),
    countedAttempts: Math.max(0, next.countedAttempts - (previous?.countedAttempts ?? 0)),
    uncountedAttempts: Math.max(0, next.uncountedAttempts - (previous?.uncountedAttempts ?? 0)),
    sourceComplete: next.sourceComplete,
    contextPending: next.contextPending,
    active:
      next.active._tag === "Unavailable"
        ? { _tag: "Unavailable" }
        : { _tag: "Available", accumulatedMillis: Math.max(0, nextActive - previousActive) },
  }
  const aggregate = ExecutionProjection.aggregateUsage([current.state, delta])
  const context = next.context ?? current.state.context
  const active =
    aggregate.active._tag === "Unavailable"
      ? aggregate.active
      : {
          _tag: "Available" as const,
          accumulatedMillis: aggregate.active.accumulatedMillis,
          ...(next.active._tag === "Available" && next.active.activeSince !== undefined
            ? { activeSince: next.active.activeSince }
            : {}),
        }
  let contextCapacity = current.contextCapacity
  if (next.context !== undefined && turn?._tag === "AgentExecution")
    contextCapacity = {
      contextWindow: turn.executionRoute.main.compaction.contextWindow,
      reserveTokens: turn.executionRoute.main.compaction.reserveTokens,
    }
  return {
    state: {
      ...aggregate,
      sourceComplete: next.sourceComplete,
      ...(context === undefined ? {} : { context }),
      contextPending: next.contextPending,
      active,
    },
    ...(contextCapacity === undefined ? {} : { contextCapacity }),
  }
}

export interface HubLive {
  readonly turnId: Turn.TurnId
  readonly preview: ExecutionGateway.ModelPreviewed
}

export type HubFrame =
  | {
      readonly _tag: "Base"
      readonly generation: number
      readonly base: ThreadView.ThreadViewSnapshot | undefined
      readonly live: HubLive | undefined
    }
  | { readonly _tag: "Patch"; readonly generation: number; readonly patch: ThreadView.ThreadViewPatch }
  | { readonly _tag: "Live"; readonly generation: number; readonly preview: HubLive }
  | {
      readonly _tag: "LiveCleared"
      readonly generation: number
      readonly turnId: Turn.TurnId
      readonly runId: string
      readonly attemptFence: number
      readonly previewGeneration: number
    }
  | { readonly _tag: "Generation"; readonly generation: number }

export interface Interface {
  readonly watch: (threadId: Thread.ThreadId) => Stream.Stream<HubFrame>
  readonly setBase: (threadId: Thread.ThreadId, base: ThreadView.ThreadViewSnapshot) => void
  readonly commitChange: (threadId: Thread.ThreadId, turn: Turn.Turn, change: ExecutionProjection.Change) => void
  readonly queueUpdated: (
    threadId: Thread.ThreadId,
    change: import("../../operation/interactive/interactive-runtime-event").QueueChange,
  ) => void
  readonly threadTitled: (threadId: Thread.ThreadId, title: string) => void
  readonly preview: (threadId: Thread.ThreadId, turnId: Turn.TurnId, preview: ExecutionGateway.ModelPreviewed) => void
  readonly clearPreview: (
    threadId: Thread.ThreadId,
    turnId: Turn.TurnId,
    cleared: ExecutionGateway.ModelPreviewCleared,
  ) => void
  readonly reset: (threadId: Thread.ThreadId) => void
}

interface Entry {
  readonly threadId: string
  generation: number
  base: ThreadView.ThreadViewSnapshot | undefined
  live: HubLive | undefined
  readonly knownProjectionRevisions: Map<string, number>
  readonly knownUsage: Map<string, ExecutionProjection.UsageState>
}

type ThreadEnvelope = { readonly threadId: string; readonly frame: HubFrame }

export const make = Effect.fn("LiveThreadProjection.make")(function* (now: () => number) {
  // Replay keeps the last published frame for a subscriber whose subscription completes while a
  // publish is in flight; the prepended Base frame covers every other ordering, so a subscriber
  // always sees the current base before any patch.
  const pubsub = yield* PubSub.unbounded<ThreadEnvelope>({ replay: 1 })
  const threads = new Map<string, Entry>()
  const entryFor = (threadId: Thread.ThreadId): Entry => {
    const key = String(threadId)
    const existing = threads.get(key)
    if (existing !== undefined) return existing
    const entry: Entry = {
      threadId: key,
      generation: 1,
      base: undefined,
      live: undefined,
      knownProjectionRevisions: new Map(),
      knownUsage: new Map(),
    }
    threads.set(key, entry)
    return entry
  }
  const emit = (entry: Entry, frame: HubFrame) => {
    PubSub.publishUnsafe(pubsub, { threadId: entry.threadId, frame })
  }
  const rememberProjection = (
    entry: Entry,
    turnId: string,
    revision: number,
    usage: ExecutionProjection.UsageState,
  ) => {
    entry.knownProjectionRevisions.delete(turnId)
    entry.knownUsage.delete(turnId)
    entry.knownProjectionRevisions.set(turnId, revision)
    entry.knownUsage.set(turnId, usage)
    while (entry.knownProjectionRevisions.size > trackedProjectionLimit) {
      const oldest = entry.knownProjectionRevisions.keys().next().value
      if (oldest === undefined) break
      entry.knownProjectionRevisions.delete(oldest)
      entry.knownUsage.delete(oldest)
    }
  }
  const remember = (entry: Entry, snapshot: ThreadView.ThreadViewSnapshot) => {
    for (const value of snapshot.turns) {
      const turnId = String(value.turn.id)
      const tracked =
        entry.knownProjectionRevisions.has(turnId) ||
        (value.turn.status !== "completed" && value.turn.status !== "failed" && value.turn.status !== "cancelled")
      if (!tracked) continue
      const revision = entry.knownProjectionRevisions.get(turnId)
      if (revision === undefined || value.projectionRevision >= revision)
        rememberProjection(entry, turnId, value.projectionRevision, value.usage)
    }
  }
  const desync = (entry: Entry) => {
    entry.generation += 1
    entry.base = undefined
    entry.live = undefined
    entry.knownProjectionRevisions.clear()
    entry.knownUsage.clear()
    emit(entry, { _tag: "Generation", generation: entry.generation })
  }
  const applyPatch = (
    entry: Entry,
    value: Omit<ThreadView.ThreadViewPatch, "threadId" | "baseRevision" | "revision">,
  ) => {
    if (entry.base === undefined) return
    const patch: ThreadView.ThreadViewPatch = {
      threadId: entry.base.thread.id,
      baseRevision: entry.base.revision,
      revision: entry.base.revision + 1,
      ...value,
    }
    const applied = ThreadView.apply(entry.base, patch)
    if (Result.isFailure(applied)) {
      desync(entry)
      return
    }
    entry.base = applied.success
    emit(entry, { _tag: "Patch", generation: entry.generation, patch })
  }
  const patchTurn = (entry: Entry, turn: Turn.Turn, change: ExecutionProjection.Change): void => {
    const changedUnits = change._tag === "ProjectionSnapshot" ? change.units : change.upsert
    const turnId = turn.id ?? changedUnits[0]?.turnId
    if (entry.base === undefined || turnId === undefined) return
    const turnKey = String(turnId)
    const existing = entry.base.turns.find((candidate) => String(candidate.turn.id) === turnKey)
    const knownRevision = entry.knownProjectionRevisions.get(turnKey) ?? existing?.projectionRevision
    const isTrackedOffWindow = existing === undefined && entry.base.hasNewer && knownRevision !== undefined
    const canInsertUnknown =
      existing === undefined && !entry.base.hasNewer && turn !== undefined && change._tag === "ProjectionSnapshot"
    if (existing === undefined && !isTrackedOffWindow && !canInsertUnknown) {
      desync(entry)
      return
    }
    if (change._tag === "ProjectionPatch" && knownRevision !== change.baseRevision) {
      desync(entry)
      return
    }
    const previousUsage = entry.knownUsage.get(turnKey) ?? existing?.usage
    const header = {
      thread: entry.base.thread,
      source: entry.base.source,
      pending: entry.base.pending,
      hasOlder: entry.base.hasOlder,
      hasNewer: entry.base.hasNewer,
      usage: nextThreadUsage(entry.base.usage, previousUsage, change.state.usage, turn),
    }
    rememberProjection(entry, turnKey, change.revision, change.state.usage)
    if (existing === undefined) {
      if (isTrackedOffWindow) return applyPatch(entry, { upsert: [], remove: [], turnChanges: [], header })
      const seed = canInsertUnknown && turn._tag === "AgentExecution" ? promptUnit(turn) : undefined
      const seededUnits =
        seed === undefined || changedUnits.some((unit) => unit.key === seed.key)
          ? changedUnits
          : [seed, ...changedUnits]
      return applyPatch(entry, {
        upsert: seededUnits,
        remove: [],
        turnChanges: [
          {
            _tag: "UpsertTurn",
            turn: { ...ThreadView.turnRecord(turn), status: change.state.status },
            projectionRevision: change.revision,
            usage: change.state.usage,
          },
        ],
        header,
      })
    }
    const record =
      turn === undefined
        ? { ...existing.turn, status: change.state.status, updatedAt: now() }
        : { ...ThreadView.turnRecord(turn), status: change.state.status, updatedAt: turn.updatedAt }
    const nextKeys =
      change._tag === "ProjectionSnapshot" && !change.hasOlder
        ? new Set(change.units.map((unit) => unit.key))
        : undefined
    const removedKeys = (): ReadonlyArray<string> => {
      if (nextKeys !== undefined)
        // A full snapshot replaces the projection's units only; prompt seeds (order sequence < 0)
        // belong to the view, not the projection, so a snapshot must not amputate them.
        return existing.units
          .filter((unit) => !nextKeys.has(unit.key) && (unit.order[0]?.sequence ?? 0) >= 0)
          .map((unit) => unit.key)
      return change._tag === "ProjectionSnapshot" ? [] : change.remove
    }
    return applyPatch(entry, {
      upsert: changedUnits,
      remove: removedKeys(),
      turnChanges: [
        {
          _tag: "UpsertTurn",
          turn: record,
          projectionRevision: change.revision,
          usage: change.state.usage,
        },
      ],
      header,
    })
  }
  return {
    watch: (threadId) => {
      const entry = entryFor(threadId)
      // Every subscriber's first frame is the atomic Base read from the current state at the
      // moment its subscription is live, so no publish ordering can strand the base. The replay
      // buffer re-delivers the last published frame; when that frame is the Base itself it is
      // replaced by the state-read Base, and older-generation frames are dropped.
      const frames = Stream.fromPubSub(pubsub).pipe(
        Stream.filter((envelope) => envelope.threadId === entry.threadId),
        Stream.map((envelope) => envelope.frame),
        Stream.mapAccum(
          () => ({
            generation: entry.generation,
            lastBase: undefined as number | undefined,
            sawFirst: false,
          }),
          (state, frame) => {
            if (frame.generation < state.generation) return [state, []] as const
            const next = {
              generation: frame._tag === "Base" || frame._tag === "Generation" ? frame.generation : state.generation,
              lastBase: frame._tag === "Base" ? frame.generation : state.lastBase,
              sawFirst: state.sawFirst,
            }
            if (!state.sawFirst) {
              const currentBase: HubFrame = {
                _tag: "Base",
                generation: next.generation,
                base: entry.base,
                live: entry.live,
              }
              next.sawFirst = true
              return frame._tag === "Base" ? ([next, [currentBase]] as const) : ([next, [currentBase, frame]] as const)
            }
            if (frame._tag === "Base" && state.lastBase === frame.generation) return [next, []] as const
            return [next, [frame]] as const
          },
        ),
      )
      return frames
    },
    setBase: (threadId, base) => {
      const entry = entryFor(threadId)
      entry.generation += 1
      entry.base = base
      entry.knownProjectionRevisions.clear()
      entry.knownUsage.clear()
      remember(entry, base)
      emit(entry, { _tag: "Base", generation: entry.generation, base, live: entry.live })
    },
    commitChange: (threadId, turn, change) => {
      const entry = entryFor(threadId)
      if (entry.base === undefined) return
      patchTurn(entry, turn, change)
    },
    queueUpdated: (threadId, change) => {
      const entry = entryFor(threadId)
      if (entry.base === undefined) return
      let items = entry.base.pending
      switch (change._tag) {
        case "Reset":
          items = pending(change.items)
          break
        case "Added":
          items = pending([...items, change.item])
          break
        case "Updated":
          items = pending(items.map((item) => (item.id === change.item.id ? change.item : item)))
          break
        case "Removed":
          items = items.filter((item) => item.id !== change.turnId)
          break
      }
      applyPatch(entry, {
        upsert: [],
        remove: [],
        turnChanges: [],
        header: {
          thread: entry.base.thread,
          source: entry.base.source,
          pending: items,
          hasOlder: entry.base.hasOlder,
          hasNewer: entry.base.hasNewer,
          usage: entry.base.usage,
        },
      })
    },
    threadTitled: (threadId, title) => {
      const entry = entryFor(threadId)
      if (entry.base === undefined || entry.base.thread.title === title) return
      applyPatch(entry, {
        upsert: [],
        remove: [],
        turnChanges: [],
        header: {
          thread: { ...entry.base.thread, title },
          source: entry.base.source,
          pending: entry.base.pending,
          hasOlder: entry.base.hasOlder,
          hasNewer: entry.base.hasNewer,
          usage: entry.base.usage,
        },
      })
    },
    preview: (threadId, turnId, preview) => {
      const entry = entryFor(threadId)
      entry.live = { turnId, preview }
      emit(entry, { _tag: "Live", generation: entry.generation, preview: entry.live })
    },
    clearPreview: (threadId, turnId, cleared) => {
      const entry = entryFor(threadId)
      if (entry.live !== undefined && entry.live.turnId !== turnId) return
      entry.live = undefined
      emit(entry, {
        _tag: "LiveCleared",
        generation: entry.generation,
        turnId,
        runId: cleared.runId,
        attemptFence: cleared.attemptFence,
        previewGeneration: cleared.generation,
      })
    },
    reset: (threadId) => {
      const entry = entryFor(threadId)
      desync(entry)
    },
  } satisfies Interface
})
