import * as ExecutionProjection from "../../../execution/projection/contract"
import * as ThreadView from "@rika/product/thread-view"
import { compareUnitOrder, encodeUnitOrder } from "@rika/transcript/transcript-unit-order"
import type { InteractiveEvent as RuntimeEvent, QueueItem } from "../session-event"
import { promptUnit } from "./prompt-unit"

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
  if (oldestCursor === undefined)
    return newestCursor === undefined ? { projectionVersion } : { projectionVersion, newestCursor }
  return newestCursor === undefined
    ? { projectionVersion, oldestCursor }
    : { projectionVersion, oldestCursor, newestCursor }
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
      pendingSteering: ReadonlyArray<ExecutionProjection.PendingSteering>
      settledSteering: ReadonlyArray<ExecutionProjection.SteeringDisposition>
    }
  >()
  for (const entry of event.entries) {
    const id = String(entry.turn.id)
    const current = grouped.get(id)
    if (current === undefined)
      grouped.set(id, {
        turn: { ...ThreadView.turnRecord(entry.turn), status: entry.projectionState.status },
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
  if (event.activeTurn !== undefined && !grouped.has(String(event.activeTurn.id)))
    grouped.set(String(event.activeTurn.id), {
      turn: ThreadView.turnRecord(event.activeTurn),
      units: [promptUnit(event.activeTurn)],
      projectionRevision: 0,
      usage: ExecutionProjection.emptyUsageState(),
      pendingSteering: [],
      settledSteering: [],
    })
  const turns = orderedTurns([...grouped.values()])
  let sourceBounds
  if (event.oldestCursor === undefined)
    sourceBounds = event.newestCursor === undefined ? {} : { newestCursor: event.newestCursor }
  else
    sourceBounds =
      event.newestCursor === undefined
        ? { oldestCursor: event.oldestCursor }
        : { oldestCursor: event.oldestCursor, newestCursor: event.newestCursor }
  const usage =
    event.usage.contextCapacity === undefined
      ? { state: event.usage.usage }
      : { state: event.usage.usage, contextCapacity: event.usage.contextCapacity }
  return {
    thread: event.thread,
    revision,
    source: sourceFor(turns, ExecutionProjection.projectionVersion, sourceBounds),
    turns,
    pending: pending(event.queue),
    hasOlder: event.hasOlder,
    hasNewer: event.hasNewer ?? false,
    usage,
  }
}

export const threadSnapshot = { fromSelection: snapshotFromSelection }
