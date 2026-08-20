import * as InteractiveEvent from "@rika/product/interactive-event"
import * as ThreadView from "@rika/product/thread-view"
import { Function, Result } from "effect"

const capacity = 64
type Event = InteractiveEvent.InteractiveEvent
type ViewEvent = Extract<Event, { readonly _tag: "ThreadViewSnapshot" | "ThreadViewPatch" | "ResyncRequired" }>
type BufferedView =
  | ViewEvent
  | { readonly _tag: "ThreadViewAccumulator"; readonly view: ThreadView.ThreadViewAccumulator }

export interface State {
  readonly views: Map<string, BufferedView>
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
  if (event._tag === "ResyncRequired") {
    state.views.set(id, event)
    return
  }
  if (event._tag === "ThreadViewSnapshot") {
    const hydrated = ThreadView.fromSnapshot(event.snapshot)
    state.views.set(id, Result.isFailure(hydrated) ? event : { _tag: "ThreadViewAccumulator", view: hydrated.success })
    return
  }
  if (current === undefined) {
    state.views.set(id, event)
    return
  }
  if (current._tag === "ResyncRequired") return
  if (current._tag === "ThreadViewPatch") {
    state.views.set(id, resync(event))
    return
  }
  if (current._tag === "ThreadViewSnapshot") {
    const hydrated = ThreadView.fromSnapshot(current.snapshot)
    if (Result.isFailure(hydrated)) {
      state.views.set(id, resync(event))
      return
    }
    const applied = hydrated.success.apply(event.patch)
    state.views.set(
      id,
      Result.isFailure(applied) ? resync(event) : { _tag: "ThreadViewAccumulator", view: hydrated.success },
    )
    return
  }
  const applied = current.view.apply(event.patch)
  if (Result.isFailure(applied)) state.views.set(id, resync(event))
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
    ? [
        ...[...state.views.values()].map(
          (event): ViewEvent =>
            event._tag === "ThreadViewAccumulator"
              ? { _tag: "ThreadViewSnapshot", snapshot: event.view.snapshot() }
              : event,
        ),
        ...state.latest.values(),
        ...state.critical,
        ...state.previewInvalidations.values(),
      ]
    : [state.degraded]
