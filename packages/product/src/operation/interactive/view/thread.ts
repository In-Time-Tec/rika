import * as ExecutionProjection from "../../../execution/projection/contract"
import * as ThreadView from "@rika/product/thread-view"
import { promptUnit } from "./prompt-unit"
import { Result } from "effect"
import type { InteractiveEvent as ClientEvent } from "../event"
import type { InteractiveEvent as RuntimeEvent, QueueItem } from "../session-event"
import { threadUsage } from "./usage"
import { threadSnapshot } from "./thread-snapshot"
const pending = (items: ReadonlyArray<QueueItem>): ReadonlyArray<ThreadView.ThreadViewPendingTurn> =>
  items.slice(0, ThreadView.limits.pending).map((item) => ({
    id: item.id,
    prompt: item.prompt,
    createdAt: item.createdAt,
  }))
const trackedProjectionLimit = 64
type ProjectionChanged = Extract<RuntimeEvent, { readonly _tag: "ExecutionProjectionChanged" }>
type ProjectionUnits = ProjectionChanged["change"] extends infer Change
  ? Change extends { readonly units: infer Units }
    ? Units
    : Change extends { readonly upsert: infer Units }
      ? Units
      : never
  : never
const requiresProjectionCheckpoint = (change: ProjectionChanged["change"], units: ProjectionUnits): boolean =>
  change.checkpoint === undefined &&
  units.some(
    (unit) =>
      unit.content._tag === "Block" &&
      unit.content.block._tag === "AuthorizationCard" &&
      unit.content.block.status === "pending",
  )
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
  const projectionChanged = (event: ProjectionChanged): ReadonlyArray<ClientEvent> => {
    if (current === undefined || event.threadId !== current.thread.id) return []
    const view = current
    const change = event.change
    const changedUnits = change._tag === "ProjectionSnapshot" ? change.units : change.upsert
    if (requiresProjectionCheckpoint(change, changedUnits)) {
      snapshotRequired = true
      return [resync(current)]
    }
    const projectionTurnId = () => event.turn?.id ?? changedUnits[0]?.turnId
    const turnId = projectionTurnId()
    if (turnId === undefined) {
      snapshotRequired = true
      return [resync(current)]
    }
    const turnKey = turnId
    const existing = view.turn(turnKey)
    const knownRevisionForTurn = () => knownProjectionRevisions.get(turnKey) ?? existing?.projectionRevision
    const projectedStatusForTurn = () => knownTerminalStatuses.get(turnKey) ?? change.state.status
    const knownRevision = knownRevisionForTurn()
    const projectedStatus = projectedStatusForTurn()
    const projectionPosition = () => {
      const isTrackedOffWindow = existing === undefined && view.hasNewer && knownRevision !== undefined
      const canInsertUnknown =
        existing === undefined && !view.hasNewer && event.turn !== undefined && change._tag === "ProjectionSnapshot"
      return { isTrackedOffWindow, canInsertUnknown }
    }
    const { isTrackedOffWindow, canInsertUnknown } = projectionPosition()
    const positionAccepted = () => existing !== undefined || isTrackedOffWindow || canInsertUnknown
    if (!positionAccepted()) {
      snapshotRequired = true
      return [resync(current)]
    }
    const revisionAccepted = () => change._tag !== "ProjectionPatch" || knownRevision === change.baseRevision
    if (!revisionAccepted()) {
      snapshotRequired = true
      return [resync(current)]
    }
    const previousUsageForTurn = () => knownUsage.get(turnKey) ?? existing?.usage
    const header = {
      thread: current.thread,
      source: current.source,
      pending: current.pending,
      hasOlder: current.hasOlder,
      hasNewer: current.hasNewer,
      usage: threadUsage.next(current.usage, previousUsageForTurn(), change.state.usage, event.turn),
    }
    const accepted = (events: ReadonlyArray<ClientEvent>) => {
      if (events.every((clientEvent) => clientEvent._tag !== "ResyncRequired")) {
        rememberProjection(turnKey, change.revision, change.state.usage)
        if (change.checkpoint !== undefined) knownCheckpoints.set(turnKey, change.checkpoint)
      }
      return events
    }
    const insertProjection = (): ReadonlyArray<ClientEvent> => {
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
    const updateProjection = (): ReadonlyArray<ClientEvent> => {
      if (existing === undefined) return insertProjection()
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
    return updateProjection()
  }
  const turnStarted = (event: Extract<RuntimeEvent, { readonly _tag: "TurnStarted" }>): ReadonlyArray<ClientEvent> => {
    if (current === undefined || event.threadId !== current.thread.id) return []
    if (current.turn(String(event.turn.id)) !== undefined) return []
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
  const turnSettled = (event: Extract<RuntimeEvent, { readonly _tag: "TurnSettled" }>): ReadonlyArray<ClientEvent> => {
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
  const queueUpdated = (
    event: Extract<RuntimeEvent, { readonly _tag: "QueueUpdated" }>,
  ): ReadonlyArray<ClientEvent> => {
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
      case "Promoted": {
        items = items.filter((item) => item.id !== change.turn.id)
        const header = {
          thread: current.thread,
          source: current.source,
          pending: items,
          hasOlder: current.hasOlder,
          hasNewer: current.hasNewer,
          usage: current.usage,
        }
        if (current.hasNewer) {
          rememberProjection(String(change.turn.id), 0, ExecutionProjection.emptyUsageState())
          return nextPatch({ upsert: [], remove: [], turnChanges: [], header })
        }
        const seed = promptUnit(change.turn)
        return nextPatch({
          upsert: [seed],
          remove: [],
          turnChanges: [
            {
              _tag: "UpsertTurn",
              turn: {
                ...ThreadView.turnRecord(change.turn),
                status: knownTerminalStatuses.get(String(change.turn.id)) ?? change.turn.status,
              },
              projectionRevision: 0,
              usage: ExecutionProjection.emptyUsageState(),
              pendingSteering: [],
              settledSteering: [],
            },
          ],
          header,
        })
      }
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
  const selectionLoaded = (event: Extract<RuntimeEvent, { readonly _tag: "SelectionLoaded" }>) => {
    const result = replace(
      threadSnapshot.fromSelection(event, current?.thread.id === event.thread.id ? current.revision + 1 : 0),
    )
    if (!snapshotRequired)
      for (const value of event.projectionCheckpoints ?? [])
        knownCheckpoints.set(String(value.turnId), value.checkpoint)
    return result
  }
  const threadTitled = (event: Extract<RuntimeEvent, { readonly _tag: "ThreadTitled" }>) => {
    if (current === undefined || event.threadId !== current.thread.id) return [event]
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
  }
  const resyncRequired = (
    event: Extract<RuntimeEvent, { readonly _tag: "ExecutionProjectionResyncRequired" | "ThreadViewResyncRequired" }>,
  ): ReadonlyArray<ClientEvent> => {
    if (current === undefined || event.threadId !== current.thread.id) return []
    snapshotRequired = true
    return [resync(current)]
  }
  const passThrough = (event: RuntimeEvent): ReadonlyArray<ClientEvent> => {
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
      default:
        return passThroughViewEvent(event)
    }
  }
  const passThroughViewEvent = (event: RuntimeEvent): ReadonlyArray<ClientEvent> => {
    switch (event._tag) {
      case "ThreadsListed":
      case "AssistantCompleted":
      case "ShellCompleted":
      case "ThreadTitled":
      case "GoalChanged":
      case "ThreadActivated":
      case "ThreadPreviewLoaded":
      case "ThreadPreviewFailed":
        return [event]
      default:
        return []
    }
  }
  const publish = (event: RuntimeEvent): ReadonlyArray<ClientEvent> => {
    if (event._tag === "SelectionLoaded") return selectionLoaded(event)
    if (event._tag === "ThreadTitled") return threadTitled(event)
    if (event._tag === "ExecutionProjectionChanged") return projectionChanged(event)
    if (event._tag === "TurnStarted") return turnStarted(event)
    if (event._tag === "TurnSettled") return turnSettled(event)
    if (event._tag === "QueueUpdated") return queueUpdated(event)
    if (event._tag === "ExecutionProjectionResyncRequired" || event._tag === "ThreadViewResyncRequired")
      return resyncRequired(event)
    return passThrough(event)
  }
  return {
    publish,
    current: () => current?.snapshot(),
    checkpoint: (turnId) => knownCheckpoints.get(turnId),
  }
}
