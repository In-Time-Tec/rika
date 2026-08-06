import * as ExecutionProjection from "../../execution/contract/execution-projection"
import { promptUnit } from "./interactive-prompt-unit"
import * as ThreadView from "@rika/product/thread-view"
import { compareUnitOrder, encodeUnitOrder } from "@rika/transcript/transcript-unit-order"
import { Result } from "effect"
import type { InteractiveEvent as ClientEvent } from "./interactive-event"
import type { InteractiveEvent as RuntimeEvent, QueueItem } from "./interactive-runtime-event"

const pending = (items: ReadonlyArray<QueueItem>): ReadonlyArray<ThreadView.ThreadViewPendingTurn> =>
  items.slice(0, ThreadView.limits.pending).map((item) => ({
    id: item.id,
    prompt: item.prompt,
    createdAt: item.createdAt,
  }))

const orderedUnits = <T extends { readonly units: ReadonlyArray<import("@rika/transcript/transcript-unit").Unit> }>(
  entry: T,
): T => ({
  ...entry,
  units: [...entry.units].toSorted((left, right) => {
    const order = compareUnitOrder(left.order, right.order)
    return order === 0 ? left.key.localeCompare(right.key) : order
  }),
})

const orderedTurns = (turns: ReadonlyArray<ThreadView.ThreadViewTurn>): ReadonlyArray<ThreadView.ThreadViewTurn> =>
  turns.map(orderedUnits).toSorted((left, right) => {
    const createdAt = left.turn.createdAt - right.turn.createdAt
    return createdAt === 0 ? String(left.turn.id).localeCompare(String(right.turn.id)) : createdAt
  })

const boundedTurns = (
  turns: ReadonlyArray<ThreadView.ThreadViewTurn>,
  edge: "oldest" | "newest",
): ReadonlyArray<ThreadView.ThreadViewTurn> => {
  const ordered = orderedTurns(turns)
  const retained = (
    edge === "oldest" ? ordered.slice(-ThreadView.limits.turns) : ordered.slice(0, ThreadView.limits.turns)
  ).map((entry) => Object.assign({}, entry, { units: [...entry.units] }))
  while (retained.length > 1) {
    const count = retained.reduce((total, entry) => total + entry.units.length, 0)
    if (count <= ThreadView.limits.timelineItems) break
    if (edge === "oldest") retained.shift()
    else retained.pop()
  }
  const only = retained.length === 1 ? retained[0]! : undefined
  if (only !== undefined && only.units.length > ThreadView.limits.timelineItems)
    only.units =
      edge === "oldest"
        ? only.units.slice(-ThreadView.limits.timelineItems)
        : only.units.slice(0, ThreadView.limits.timelineItems)
  return retained
}

const sourceFor = (
  turns: ReadonlyArray<ThreadView.ThreadViewTurn>,
  projectionVersion: number,
  boundaries: Pick<ThreadView.ThreadViewSource, "oldestCursor" | "newestCursor"> = {},
): ThreadView.ThreadViewSource => {
  const oldest = turns.find((entry) => entry.units.length > 0)
  const newest = turns.findLast((entry) => entry.units.length > 0)
  const oldestUnit = oldest?.units[0]
  const newestUnit = newest?.units.at(-1)
  const oldestCursor =
    boundaries.oldestCursor ??
    (oldest === undefined || oldestUnit === undefined
      ? undefined
      : {
          createdAt: oldest.turn.createdAt,
          turnId: oldest.turn.id,
          orderKey: encodeUnitOrder(oldestUnit.order),
        })
  const newestCursor =
    boundaries.newestCursor ??
    (newest === undefined || newestUnit === undefined
      ? undefined
      : {
          createdAt: newest.turn.createdAt,
          turnId: newest.turn.id,
          orderKey: encodeUnitOrder(newestUnit.order),
        })
  return {
    projectionVersion,
    ...(oldestCursor === undefined ? {} : { oldestCursor }),
    ...(newestCursor === undefined ? {} : { newestCursor }),
  }
}

const unitCount = (turns: ReadonlyArray<ThreadView.ThreadViewTurn>): number =>
  turns.reduce((total, entry) => total + entry.units.length, 0)

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
      ...(difference(next.input.cacheWrite, previous?.input.cacheWrite) === undefined
        ? {}
        : { cacheWrite: difference(next.input.cacheWrite, previous?.input.cacheWrite)! }),
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

const snapshotFromSelection = (
  event: Extract<RuntimeEvent, { readonly _tag: "SelectionLoaded" }>,
  revision: number,
): ThreadView.ThreadViewSnapshot => {
  const grouped = new Map<
    string,
    {
      readonly turn: ThreadView.ThreadViewTurnRecord
      readonly units: Array<import("@rika/transcript/transcript-unit").Unit>
      projectionRevision: number
      usage: ExecutionProjection.UsageState
    }
  >()
  for (const entry of event.entries) {
    const id = String(entry.turn.id)
    const current = grouped.get(id)
    if (current === undefined)
      grouped.set(id, {
        turn: ThreadView.turnRecord(entry.turn),
        units: [entry.unit],
        projectionRevision: entry.projectionRevision,
        usage: entry.projectionState.usage,
      })
    else {
      current.units.push(entry.unit)
      if (entry.projectionRevision >= current.projectionRevision) current.usage = entry.projectionState.usage
      current.projectionRevision = Math.max(current.projectionRevision, entry.projectionRevision)
    }
  }
  if (event.activeTurn !== undefined && !grouped.has(String(event.activeTurn.id))) {
    grouped.set(String(event.activeTurn.id), {
      turn: ThreadView.turnRecord(event.activeTurn),
      units: [promptUnit(event.activeTurn)],
      projectionRevision: 0,
      usage: ExecutionProjection.emptyUsageState(),
    })
  }
  const groupedTurns = [...grouped.values()]
  const turns = boundedTurns(groupedTurns, "oldest")
  return {
    thread: event.thread,
    revision,
    source: sourceFor(turns, ExecutionProjection.projectionVersion, {
      ...(event.oldestCursor === undefined ? {} : { oldestCursor: event.oldestCursor }),
      ...(event.newestCursor === undefined ? {} : { newestCursor: event.newestCursor }),
    }),
    turns,
    pending: pending(event.queue),
    hasOlder: event.hasOlder || unitCount(turns) < unitCount(groupedTurns),
    hasNewer: event.hasNewer ?? false,
    usage: {
      state: event.usage.usage,
      ...(event.usage.contextCapacity === undefined ? {} : { contextCapacity: event.usage.contextCapacity }),
    },
  }
}

const resync = (snapshot: ThreadView.ThreadViewSnapshot, receivedBaseRevision = snapshot.revision) =>
  ThreadView.ResyncRequired.make({
    threadId: snapshot.thread.id,
    expectedRevision: snapshot.revision + 1,
    receivedBaseRevision,
    currentRevision: snapshot.revision,
  })

export interface ThreadViewFeed {
  readonly publish: (event: RuntimeEvent) => ReadonlyArray<ClientEvent>
  readonly current: () => ThreadView.ThreadViewSnapshot | undefined
}

export const makeThreadViewFeed = (now: () => number): ThreadViewFeed => {
  let current: ThreadView.ThreadViewSnapshot | undefined
  let snapshotRequired = false
  let knownThreadId: string | undefined
  const knownProjectionRevisions = new Map<string, number>()
  const knownUsage = new Map<string, ExecutionProjection.UsageState>()

  const rememberProjection = (turnId: string, revision: number, usage: ExecutionProjection.UsageState) => {
    knownProjectionRevisions.delete(turnId)
    knownUsage.delete(turnId)
    knownProjectionRevisions.set(turnId, revision)
    knownUsage.set(turnId, usage)
    while (knownProjectionRevisions.size > trackedProjectionLimit) {
      const oldest = knownProjectionRevisions.keys().next().value
      if (oldest === undefined) break
      knownProjectionRevisions.delete(oldest)
      knownUsage.delete(oldest)
    }
  }

  const remember = (snapshot: ThreadView.ThreadViewSnapshot) => {
    const threadId = String(snapshot.thread.id)
    if (knownThreadId !== threadId) {
      knownThreadId = threadId
      knownProjectionRevisions.clear()
      knownUsage.clear()
    }
    for (const entry of snapshot.turns) {
      const turnId = String(entry.turn.id)
      const tracked =
        knownProjectionRevisions.has(turnId) ||
        (entry.turn.status !== "completed" && entry.turn.status !== "failed" && entry.turn.status !== "cancelled")
      if (!tracked) continue
      const revision = knownProjectionRevisions.get(turnId)
      if (revision === undefined || entry.projectionRevision >= revision)
        rememberProjection(turnId, entry.projectionRevision, entry.usage)
    }
  }

  const replace = (snapshot: ThreadView.ThreadViewSnapshot): ReadonlyArray<ClientEvent> => {
    current = snapshot
    remember(snapshot)
    snapshotRequired = false
    return [{ _tag: "ThreadViewSnapshot", snapshot }]
  }

  const patch = (value: ThreadView.ThreadViewPatch): ReadonlyArray<ClientEvent> => {
    if (current === undefined || snapshotRequired) return []
    const applied = ThreadView.apply(current, value)
    if (Result.isFailure(applied)) {
      snapshotRequired = true
      return [resync(current, value.baseRevision)]
    }
    current = applied.success
    return [{ _tag: "ThreadViewPatch", patch: value }]
  }

  const nextPatch = (
    change: Omit<ThreadView.ThreadViewPatch, "threadId" | "baseRevision" | "revision">,
  ): ReadonlyArray<ClientEvent> => {
    if (current === undefined || snapshotRequired) return []
    return patch({
      threadId: current.thread.id,
      baseRevision: current.revision,
      revision: current.revision + 1,
      ...change,
    })
  }

  const publish = (event: RuntimeEvent): ReadonlyArray<ClientEvent> => {
    if (event._tag === "SelectionLoaded")
      return replace(snapshotFromSelection(event, current?.thread.id === event.thread.id ? current.revision + 1 : 0))
    if (current !== undefined && event._tag === "ThreadTitled" && event.threadId === current.thread.id)
      return nextPatch({
        upsert: [],
        remove: [],
        turnChanges: [],
        header: {
          thread: { ...current.thread, title: event.title },
          source: current.source,
          pending: current.pending,
          hasOlder: current.hasOlder,
          hasNewer: current.hasNewer,
          usage: current.usage,
        },
      })
    if (event._tag === "ExecutionProjectionChanged") {
      if (current === undefined || event.threadId !== current.thread.id) return []
      const change = event.change
      const changedUnits = change._tag === "ProjectionSnapshot" ? change.units : change.upsert
      const turnId = event.turn?.id ?? changedUnits[0]?.turnId
      if (turnId === undefined) {
        snapshotRequired = true
        return [resync(current)]
      }
      const turnKey = String(turnId)
      const existing = current.turns.find((entry) => String(entry.turn.id) === turnKey)
      const knownRevision = knownProjectionRevisions.get(turnKey) ?? existing?.projectionRevision
      const isTrackedOffWindow = existing === undefined && current.hasNewer && knownRevision !== undefined
      const canInsertUnknown =
        existing === undefined && !current.hasNewer && event.turn !== undefined && change._tag === "ProjectionSnapshot"
      if (existing === undefined && !isTrackedOffWindow && !canInsertUnknown) {
        snapshotRequired = true
        return [resync(current)]
      }
      if (change._tag === "ProjectionPatch" && knownRevision !== change.baseRevision) {
        snapshotRequired = true
        return [resync(current)]
      }
      const previousUsage = knownUsage.get(turnKey) ?? existing?.usage
      const header = {
        thread: current.thread,
        source: current.source,
        pending: current.pending,
        hasOlder: current.hasOlder,
        hasNewer: current.hasNewer,
        usage: nextThreadUsage(current.usage, previousUsage, change.state.usage, event.turn),
      }
      rememberProjection(turnKey, change.revision, change.state.usage)
      if (existing === undefined) {
        if (isTrackedOffWindow)
          return nextPatch({
            upsert: [],
            remove: [],
            turnChanges: [],
            header,
          })
        return nextPatch({
          upsert: changedUnits,
          remove: [],
          turnChanges: [
            {
              _tag: "UpsertTurn",
              turn: { ...ThreadView.turnRecord(event.turn!), status: change.state.status },
              projectionRevision: change.revision,
              usage: change.state.usage,
            },
          ],
          header,
        })
      }
      const record =
        event.turn === undefined
          ? { ...existing.turn, status: change.state.status, updatedAt: now() }
          : { ...ThreadView.turnRecord(event.turn), status: change.state.status, updatedAt: event.turn.updatedAt }
      const nextKeys =
        change._tag === "ProjectionSnapshot" && !change.hasOlder
          ? new Set(change.units.map((unit) => unit.key))
          : undefined
      const removedKeys = (): ReadonlyArray<string> => {
        if (nextKeys !== undefined)
          return existing.units.filter((unit) => !nextKeys.has(unit.key)).map((unit) => unit.key)
        return change._tag === "ProjectionSnapshot" ? [] : change.remove
      }
      return nextPatch({
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
    if (event._tag === "TurnStarted") {
      if (current === undefined || event.threadId !== current.thread.id) return []
      if (current.hasNewer) {
        rememberProjection(String(event.turn.id), 0, ExecutionProjection.emptyUsageState())
        return []
      }
      const seed = promptUnit(event.turn)
      return nextPatch({
        upsert: [seed],
        remove: [],
        turnChanges: [
          {
            _tag: "UpsertTurn",
            turn: ThreadView.turnRecord(event.turn),
            projectionRevision: 0,
            usage: ExecutionProjection.emptyUsageState(),
          },
        ],
      })
    }
    if (event._tag === "TurnSettled") {
      if (current === undefined || event.threadId !== current.thread.id) return []
      knownProjectionRevisions.delete(String(event.turnId))
      knownUsage.delete(String(event.turnId))
      const existing = current.turns.find((entry) => entry.turn.id === event.turnId)
      if (existing === undefined) return []
      return nextPatch({
        upsert: [],
        remove: [],
        turnChanges: [
          {
            _tag: "UpsertTurn",
            turn: { ...existing.turn, status: event.status, updatedAt: now() },
            projectionRevision: existing.projectionRevision,
            usage: existing.usage,
          },
        ],
      })
    }
    if (event._tag === "QueueUpdated") {
      if (current === undefined || event.threadId !== current.thread.id) return []
      let items = current.pending
      const change = event.change
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
      return nextPatch({
        upsert: [],
        remove: [],
        turnChanges: [],
        header: {
          thread: current.thread,
          source: current.source,
          pending: items,
          hasOlder: current.hasOlder,
          hasNewer: current.hasNewer,
          usage: current.usage,
        },
      })
    }
    if (event._tag === "TranscriptPagePrepended" || event._tag === "TranscriptPageAppended") {
      if (current === undefined || event.threadId !== current.thread.id) return []
      const byTurn = new Map(
        current.turns.map((entry) => [String(entry.turn.id), { ...entry, units: [...entry.units] }]),
      )
      for (const entry of event.entries) {
        const id = String(entry.turn.id)
        const value = byTurn.get(id)
        if (value === undefined)
          byTurn.set(id, {
            turn: ThreadView.turnRecord(entry.turn),
            units: [entry.unit],
            projectionRevision: entry.projectionRevision,
            usage: entry.projectionState.usage,
          })
        else {
          const index = value.units.findIndex((unit) => unit.key === entry.unit.key)
          if (index === -1) value.units.push(entry.unit)
          else value.units[index] = entry.unit
          if (entry.projectionRevision >= value.projectionRevision) value.usage = entry.projectionState.usage
          value.projectionRevision = Math.max(value.projectionRevision, entry.projectionRevision)
        }
      }
      const combined = [...byTurn.values()]
      const prepended = event._tag === "TranscriptPagePrepended"
      const turns = boundedTurns(combined, prepended ? "newest" : "oldest")
      const truncated = unitCount(turns) < unitCount(combined)
      return replace({
        ...current,
        revision: current.revision + 1,
        source: sourceFor(turns, current.source.projectionVersion, {
          ...(prepended && event.oldestCursor !== undefined ? { oldestCursor: event.oldestCursor } : {}),
          ...(!prepended && event.newestCursor !== undefined ? { newestCursor: event.newestCursor } : {}),
        }),
        turns,
        hasOlder: prepended ? event.hasOlder : current.hasOlder || truncated,
        hasNewer: prepended ? current.hasNewer || truncated : event.hasNewer,
      })
    }
    if (event._tag === "ExecutionProjectionResyncRequired" || event._tag === "ThreadViewResyncRequired") {
      if (current === undefined || event.threadId !== current.thread.id) return []
      snapshotRequired = true
      return [resync(current)]
    }
    switch (event._tag) {
      case "ContextDiagnostics":
      case "ExecutionFailed":
      case "ExecutionControlFailed":
      case "QueueFull":
      case "SubmissionAdmitted":
      case "ExecutionControlled":
      case "ThreadRefolding": {
        const { selectionEpoch: _, ...value } = event
        return [value]
      }
      case "ThreadsListed":
      case "AssistantCompleted":
      case "ShellCompleted":
      case "ThreadTitled":
      case "ThreadActivated":
      case "ThreadPreviewLoaded":
      case "ThreadPreviewFailed":
        return [event]
        return []
    }
  }
  return { publish, current: () => current }
}
