import * as ExecutionProjection from "../../execution/contract/execution-projection"
import { promptUnit } from "./interactive-prompt-unit"
import * as Thread from "@rika/product/thread-record"
import * as ThreadView from "@rika/product/thread-view"
import { compareUnitOrder, encodeUnitOrder } from "@rika/transcript/transcript-unit-order"
import type * as LiveThreadProjection from "../../thread/projection/live-thread-projection"
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
  const turns = orderedTurns(groupedTurns)
  return {
    thread: event.thread,
    revision,
    source: sourceFor(turns, ExecutionProjection.projectionVersion, {
      ...(event.oldestCursor === undefined ? {} : { oldestCursor: event.oldestCursor }),
      ...(event.newestCursor === undefined ? {} : { newestCursor: event.newestCursor }),
    } as Pick<ThreadView.ThreadViewSource, "oldestCursor" | "newestCursor">),
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

const resyncFor = (threadId: Thread.ThreadId) =>
  ThreadView.ResyncRequired.make({
    threadId,
    expectedRevision: 0,
    receivedBaseRevision: 0,
    currentRevision: 0,
  })

export interface ThreadViewFeed {
  readonly publish: (event: RuntimeEvent) => ReadonlyArray<ClientEvent>
}

export const makeThreadViewFeed = (hub: LiveThreadProjection.Interface): ThreadViewFeed => {
  const publish = (event: RuntimeEvent): ReadonlyArray<ClientEvent> => {
    if (event._tag === "SelectionLoaded") {
      // The hub owns the authoritative base; every selection rebuilds it from the durable
      // transcript page and bumps the generation so every subscriber replaces its namespace.
      hub.setBase(event.thread.id, snapshotFromSelection(event, 0))
      return []
    }
    switch (event._tag) {
      case "ThreadViewHubBase":
        // A subscriber can attach between selection and the durable base landing; the live Base
        // frame arrives right behind it. Dropping keeps the atomic base the single admission.
        if (event.base === undefined) return []
        return [
          { _tag: "ThreadViewSnapshot", generation: event.generation, snapshot: event.base },
          ...(event.live === undefined
            ? []
            : ([
                {
                  _tag: "ExecutionModelPreviewed",
                  threadId: event.threadId,
                  turnId: event.live.turnId,
                  preview: event.live.preview,
                },
              ] satisfies ReadonlyArray<ClientEvent>)),
        ]
      case "ThreadViewHubPatch":
        return [{ _tag: "ThreadViewPatch", generation: event.generation, patch: event.patch }]
      case "ThreadViewHubLive":
        return [
          {
            _tag: "ExecutionModelPreviewed",
            threadId: event.threadId,
            turnId: event.preview.turnId,
            preview: event.preview.preview,
          },
        ]
      case "ThreadViewHubLiveCleared":
        return [
          {
            _tag: "ExecutionModelPreviewCleared",
            threadId: event.threadId,
            turnId: event.turnId,
            runId: event.runId,
            attemptFence: event.attemptFence,
            generation: event.previewGeneration,
          },
        ]
      case "ThreadViewHubGeneration":
        return [resyncFor(event.threadId)]
      case "ThreadTitled":
        hub.threadTitled(Thread.ThreadId.make(String(event.threadId)), event.title)
        return [event]
      case "QueueUpdated":
        hub.queueUpdated(event.threadId, event.change)
        return []
      case "TurnStarted":
        return [
          {
            _tag: "TurnStarted",
            threadId: event.threadId,
            turnId: event.turn.id,
            prompt: event.turn.prompt,
            ...(event.submissionId === undefined ? {} : { submissionId: event.submissionId }),
          },
        ]
      case "ExecutionProjectionChanged":
      case "TurnSettled":
        return []
      case "ExecutionProjectionResyncRequired":
      case "ThreadViewResyncRequired":
        return [resyncFor(event.threadId)]
      default: {
        const { selectionEpoch: _, ...value } = event as RuntimeEvent & { readonly selectionEpoch?: number }
        return [value as ClientEvent]
      }
    }
  }
  return { publish }
}
