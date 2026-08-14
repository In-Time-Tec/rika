import * as InteractiveEvent from "@rika/product/interactive-event"
import * as ThreadView from "@rika/product/thread-view"
import { Function, Result } from "effect"

const capacity = 64
const patchItemCapacity = 120
const turnChangeCapacity = 6

type Event = InteractiveEvent.InteractiveEvent
type PatchEvent = Extract<Event, { readonly _tag: "ThreadViewPatch" }>
type ViewEvent = Extract<Event, { readonly _tag: "ThreadViewSnapshot" | "ThreadViewPatch" | "ResyncRequired" }>

export interface State {
  readonly views: Map<string, ViewEvent>
  readonly latest: Map<string, Event>
  readonly critical: Array<Event>
  readonly previewInvalidations: Map<string, Extract<Event, { readonly _tag: "ExecutionModelPreviewChanged" }>>
  degraded?: Event
}

export const make = (): State => ({
  views: new Map(),
  latest: new Map(),
  critical: [],
  previewInvalidations: new Map(),
})

const resync = (event: Extract<Event, { readonly _tag: "ThreadViewPatch" }>): ViewEvent =>
  ThreadView.ResyncRequired.make({
    threadId: event.patch.threadId,
    expectedRevision: event.patch.revision,
    receivedBaseRevision: event.patch.baseRevision,
    currentRevision: event.patch.baseRevision,
  })

const mergePatch = (current: PatchEvent, next: PatchEvent): PatchEvent | undefined => {
  if (
    String(current.patch.threadId) !== String(next.patch.threadId) ||
    current.patch.revision !== next.patch.baseRevision
  )
    return undefined
  const upsert = new Map(current.patch.upsert.map((unit) => [unit.key, unit] as const))
  const remove = new Set(current.patch.remove)
  for (const unit of next.patch.upsert) {
    if (remove.has(unit.key)) return undefined
    upsert.set(unit.key, unit)
  }
  for (const key of next.patch.remove) {
    if (upsert.has(key)) return undefined
    remove.add(key)
  }
  const turnChanges = new Map(
    current.patch.turnChanges.map(
      (change) => [String(change._tag === "UpsertTurn" ? change.turn.id : change.turnId), change] as const,
    ),
  )
  for (const change of next.patch.turnChanges) {
    const key = String(change._tag === "UpsertTurn" ? change.turn.id : change.turnId)
    const previous = turnChanges.get(key)
    if (previous !== undefined && previous._tag !== change._tag) return undefined
    turnChanges.set(key, change)
  }
  if (upsert.size + remove.size > patchItemCapacity || turnChanges.size > turnChangeCapacity) return undefined
  const header = next.patch.header ?? current.patch.header
  return {
    _tag: "ThreadViewPatch",
    patch: {
      threadId: current.patch.threadId,
      baseRevision: current.patch.baseRevision,
      revision: next.patch.revision,
      upsert: [...upsert.values()],
      remove: [...remove],
      turnChanges: [...turnChanges.values()],
      ...(header === undefined ? {} : { header }),
    },
  }
}

const recovery = (event: Event): Event => {
  if (event._tag === "ThreadViewPatch") return resync(event)
  return event
}

const degrade = (state: State, event: Event) => {
  state.views.clear()
  state.latest.clear()
  state.critical.length = 0
  state.previewInvalidations.clear()
  state.degraded = recovery(event)
}

const viewId = (event: ViewEvent): string => {
  if (event._tag === "ThreadViewSnapshot") return String(event.snapshot.thread.id)
  if (event._tag === "ResyncRequired") return String(event.threadId)
  return String(event.patch.threadId)
}

const rememberView = (state: State, event: ViewEvent) => {
  const id = viewId(event)
  const current = state.views.get(id)
  if (current === undefined && state.views.size >= capacity) return degrade(state, event)
  if (event._tag === "ThreadViewSnapshot" || event._tag === "ResyncRequired") {
    state.views.set(id, event)
    return
  }
  if (current === undefined) {
    state.views.set(id, event)
    return
  }
  if (current._tag === "ResyncRequired") return
  if (current._tag === "ThreadViewPatch") {
    state.views.set(id, mergePatch(current, event) ?? resync(event))
    return
  }
  const applied = ThreadView.apply(current.snapshot, event.patch)
  state.views.set(
    id,
    Result.isFailure(applied) ? resync(event) : { _tag: "ThreadViewSnapshot", snapshot: applied.success },
  )
}

const rememberImpl = (state: State, event: Event) => {
  if (event._tag === "ExecutionModelPreviewChanged") {
    if (state.degraded !== undefined) return
    const invalidation: Extract<Event, { readonly _tag: "ExecutionModelPreviewChanged" }> = {
      ...event,
      preview: {
        _tag: "ModelPreviewCleared",
        runId: event.preview.runId,
        ...(event.preview.parentId === undefined ? {} : { parentId: event.preview.parentId }),
        attemptFence: event.preview.attemptFence,
        generation: event.preview._tag === "ModelPreviewCleared" ? event.preview.generation : 0,
      },
    }
    const key = `${event.threadId}:${event.turnId}:${event.preview.runId}`
    if (!state.previewInvalidations.has(key) && state.previewInvalidations.size >= capacity)
      degrade(state, invalidation)
    else state.previewInvalidations.set(key, invalidation)
    return
  }
  if (state.degraded !== undefined) {
    // The degraded recovery is a thread resync: only a newer view event may replace it. A later
    // control event must not overwrite the resync, or the client would stay durably stale while
    // the recovery frame that could repair it is lost.
    if (event._tag === "ThreadViewSnapshot" || event._tag === "ThreadViewPatch" || event._tag === "ResyncRequired")
      state.degraded = recovery(event)
    return
  }
  if (event._tag === "ThreadViewSnapshot" || event._tag === "ThreadViewPatch" || event._tag === "ResyncRequired") {
    rememberView(state, event)
    return
  }
  let key: string | undefined
  switch (event._tag) {
    case "ThreadsListed":
      key = "threads"
      break
    case "ThreadRefolding":
      key = `refolding:${event.threadId}`
      break
    case "QueueFull":
      key = `queue-full:${event.threadId}`
      break
    case "SubmissionAdmitted":
      key = `admitted:${event.threadId}:${event.turnId}`
      break
    case "ThreadTitled":
      key = `title:${event.threadId}`
      break
    case "GoalChanged":
      key = `goal:${event.threadId}`
      break
    case "ThreadActivated":
      key = "activated"
      break
    case "ThreadPreviewLoaded":
    case "ThreadPreviewFailed":
      key = `preview:${event.threadId}:${event.requestId}`
      break
  }
  if (key !== undefined) {
    if (!state.latest.has(key) && state.latest.size >= capacity) degrade(state, event)
    else state.latest.set(key, event)
    return
  }
  if (state.critical.length >= capacity) degrade(state, event)
  else state.critical.push(event)
}

export const remember: {
  (state: State, event: Event): void
  (event: Event): (state: State) => void
} = Function.dual(2, rememberImpl)

export const events = (state: State): ReadonlyArray<Event> =>
  state.degraded === undefined
    ? [...state.views.values(), ...state.latest.values(), ...state.critical, ...state.previewInvalidations.values()]
    : [state.degraded]
