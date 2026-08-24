import * as ExecutionProjection from "../../../execution/contract/execution-projection"
import * as ThreadView from "@rika/product/thread-view"
import { promptUnit } from "./transcript-window"
import { compareUnitOrder, encodeUnitOrder } from "@rika/transcript/transcript-unit-order"
import { Result } from "effect"
import { type InteractiveEvent as ClientEvent } from "../event"
import { type InteractiveEvent as RuntimeEvent, type QueueItem } from "../session-event"
import { threadUsage } from "./usage"
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
const trackedProjectionLimit = 64
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
      pendingSteering: ReadonlyArray<ExecutionProjection.PendingSteering>
      settledSteering: ReadonlyArray<ExecutionProjection.SteeringDisposition>
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
        pendingSteering: entry.projectionState.steering.pending ?? [],
        settledSteering: entry.projectionState.steering.settled ?? [],
      })
    else {
      current.units.push(entry.unit)
      if (entry.projectionRevision >= current.projectionRevision) {
        current.usage = entry.projectionState.usage
        current.pendingSteering = entry.projectionState.steering.pending ?? []
        current.settledSteering = entry.projectionState.steering.settled ?? []
      }
      current.projectionRevision = Math.max(current.projectionRevision, entry.projectionRevision)
    }
  }
  if (event.activeTurn !== undefined && !grouped.has(String(event.activeTurn.id))) {
    grouped.set(String(event.activeTurn.id), {
      turn: ThreadView.turnRecord(event.activeTurn),
      units: [promptUnit(event.activeTurn)],
      projectionRevision: 0,
      usage: ExecutionProjection.emptyUsageState(),
      pendingSteering: [],
      settledSteering: [],
    })
  }
  const groupedTurns = [...grouped.values()]
  const turns = orderedTurns(groupedTurns)
  return {
    thread: event.thread,
    revision,
    source: sourceFor(turns, ExecutionProjection.projectionVersion, {
      ...(event.oldestCursor === undefined ? {} : { oldestCursor: event.oldestCursor }),
      ...(event.newestCursor === undefined ? {} : { newestCursor: event.newestCursor }),
    }),
    turns,
    pending: pending(event.queue),
    hasOlder: event.hasOlder,
    hasNewer: event.hasNewer ?? false,
    usage: {
      state: event.usage.usage,
      ...(event.usage.contextCapacity === undefined ? {} : { contextCapacity: event.usage.contextCapacity }),
    },
  }
}
const resync = (
  view: Pick<ThreadView.ThreadViewAccumulator, "thread" | "revision">,
  receivedBaseRevision = view.revision,
) =>
  ThreadView.ResyncRequired.make({
    threadId: view.thread.id,
    expectedRevision: view.revision + 1,
    receivedBaseRevision,
    currentRevision: view.revision,
  })
export interface ThreadViewFeed {
  readonly publish: (event: RuntimeEvent) => ReadonlyArray<ClientEvent>
  readonly current: () => ThreadView.ThreadViewSnapshot | undefined
  readonly checkpoint: (turnId: string) => ExecutionProjection.Checkpoint | undefined
}
export const makeThreadViewFeed = (now: () => number): ThreadViewFeed => {
  let current: ThreadView.ThreadViewAccumulator | undefined
  let snapshotRequired = false
  let knownThreadId: string | undefined
  const knownProjectionRevisions = new Map<string, number>()
  const knownUsage = new Map<string, ExecutionProjection.UsageState>()
  const knownCheckpoints = new Map<string, ExecutionProjection.Checkpoint>()
  const knownTerminalStatuses = new Map<string, "completed" | "failed" | "cancelled">()
  const rememberTerminal = (turnId: string, status: "completed" | "failed" | "cancelled") => {
    knownTerminalStatuses.delete(turnId)
    knownTerminalStatuses.set(turnId, status)
    while (knownTerminalStatuses.size > trackedProjectionLimit) {
      const oldest = knownTerminalStatuses.keys().next().value
      if (oldest === undefined) break
      knownTerminalStatuses.delete(oldest)
    }
  }
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
      knownCheckpoints.clear()
      knownTerminalStatuses.clear()
    }
    for (const entry of snapshot.turns) {
      if (entry.turn.status === "completed" || entry.turn.status === "failed" || entry.turn.status === "cancelled")
        rememberTerminal(String(entry.turn.id), entry.turn.status)
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
  const replace = (incoming: ThreadView.ThreadViewSnapshot): ReadonlyArray<ClientEvent> => {
    const snapshot: ThreadView.ThreadViewSnapshot = {
      ...incoming,
      turns: incoming.turns.map((entry) => {
        const terminal = knownTerminalStatuses.get(String(entry.turn.id))
        return terminal === undefined ? entry : { ...entry, turn: { ...entry.turn, status: terminal } }
      }),
    }
    const hydrated = ThreadView.fromSnapshot(snapshot)
    if (Result.isFailure(hydrated)) {
      current = undefined
      snapshotRequired = true
      return [resync(snapshot)]
    }
    current = hydrated.success
    remember(snapshot)
    snapshotRequired = false
    return [{ _tag: "ThreadViewSnapshot", snapshot }]
  }
  const patch = (value: ThreadView.ThreadViewPatch): ReadonlyArray<ClientEvent> => {
    if (current === undefined || snapshotRequired) return []
    const applied = current.apply(value)
    if (Result.isFailure(applied)) {
      snapshotRequired = true
      return [resync(current, value.baseRevision)]
    }
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
      if (
        change.checkpoint === undefined &&
        changedUnits.some(
          (unit) =>
            unit.content._tag === "Block" &&
            unit.content.block._tag === "AuthorizationCard" &&
            unit.content.block.status === "pending",
        )
      ) {
        snapshotRequired = true
        return [resync(current)]
      }
      const turnId = event.turn?.id ?? changedUnits[0]?.turnId
      if (turnId === undefined) {
        snapshotRequired = true
        return [resync(current)]
      }
      const turnKey = String(turnId)
      const existing = current.turn(turnKey)
      const knownRevision = knownProjectionRevisions.get(turnKey) ?? existing?.projectionRevision
      const projectedStatus = knownTerminalStatuses.get(turnKey) ?? change.state.status
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
        usage: threadUsage.next(current.usage, previousUsage, change.state.usage, event.turn),
      }
      const accepted = (events: ReadonlyArray<ClientEvent>) => {
        if (events.every((clientEvent) => clientEvent._tag !== "ResyncRequired")) {
          rememberProjection(turnKey, change.revision, change.state.usage)
          if (change.checkpoint !== undefined) knownCheckpoints.set(turnKey, change.checkpoint)
        }
        return events
      }
      if (existing === undefined) {
        if (isTrackedOffWindow)
          return accepted(
            nextPatch({
              upsert: [],
              remove: [],
              turnChanges: [],
              header,
            }),
          )
        return accepted(
          nextPatch({
            upsert: changedUnits,
            remove: [],
            turnChanges: [
              {
                _tag: "UpsertTurn",
                turn: { ...ThreadView.turnRecord(event.turn!), status: projectedStatus },
                projectionRevision: change.revision,
                usage: change.state.usage,
                pendingSteering: change.state.steering.pending ?? [],
                settledSteering: change.state.steering.settled ?? [],
              },
            ],
            header,
          }),
        )
      }
      const record =
        event.turn === undefined
          ? { ...existing.turn, status: projectedStatus, updatedAt: now() }
          : { ...ThreadView.turnRecord(event.turn), status: projectedStatus, updatedAt: event.turn.updatedAt }
      const nextKeys =
        change._tag === "ProjectionSnapshot" && !change.hasOlder
          ? new Set(change.units.map((unit) => unit.key))
          : undefined
      const removedKeys = (): ReadonlyArray<string> => {
        if (nextKeys !== undefined)
          return current!
            .units(turnKey)
            .filter((unit) => !nextKeys.has(unit.key))
            .map((unit) => unit.key)
        return change._tag === "ProjectionSnapshot" ? [] : change.remove
      }
      return accepted(
        nextPatch({
          upsert: changedUnits,
          remove: removedKeys(),
          turnChanges: [
            {
              _tag: "UpsertTurn",
              turn: record,
              projectionRevision: change.revision,
              usage: change.state.usage,
              pendingSteering: change.state.steering.pending ?? [],
              settledSteering: change.state.steering.settled ?? [],
            },
          ],
          header,
        }),
      )
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
            turn: {
              ...ThreadView.turnRecord(event.turn),
              status: knownTerminalStatuses.get(String(event.turn.id)) ?? event.turn.status,
            },
            projectionRevision: 0,
            usage: ExecutionProjection.emptyUsageState(),
            pendingSteering: [],
            settledSteering: [],
          },
        ],
      })
    }
    if (event._tag === "TurnSettled") {
      if (current === undefined || event.threadId !== current.thread.id) return []
      rememberTerminal(String(event.turnId), event.status)
      knownProjectionRevisions.delete(String(event.turnId))
      knownUsage.delete(String(event.turnId))
      const existing = current.turn(String(event.turnId))
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
            pendingSteering: existing.pendingSteering ?? [],
            settledSteering: existing.settledSteering ?? [],
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
        case "Added": {
          const inserted = [...items]
          inserted.splice(Math.min(change.position ?? inserted.length, inserted.length), 0, change.item)
          items = pending(inserted)
          break
        }
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
    if (event._tag === "ExecutionProjectionResyncRequired" || event._tag === "ThreadViewResyncRequired") {
      if (current === undefined || event.threadId !== current.thread.id) return []
      snapshotRequired = true
      return [resync(current)]
    }
    switch (event._tag) {
      case "ExecutionModelPreviewChanged":
        return current !== undefined && event.threadId === current.thread.id ? [event] : []
      case "ContextDiagnostics":
      case "TurnRetryScheduled":
      case "ExecutionFailed":
      case "SubmissionRejected":
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
      case "GoalChanged":
      case "ThreadActivated":
      case "ThreadPreviewLoaded":
      case "ThreadPreviewFailed":
        return [event]
    }
  }
  return {
    publish,
    current: () => current?.snapshot(),
    checkpoint: (turnId) => knownCheckpoints.get(turnId),
  }
}
