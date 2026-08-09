import * as ThreadView from "@rika/product/thread-view"
import { Function } from "effect"
import type { InteractiveEvent } from "./interactive-event"

export const capacity = 64

export interface State {
  readonly snapshots: Map<string, Extract<InteractiveEvent, { readonly _tag: "ThreadViewSnapshot" }>>
  readonly resync: Map<string, ThreadView.ResyncRequired>
  readonly latest: Map<string, InteractiveEvent>
  readonly critical: Array<InteractiveEvent>
  criticalOverflowed: boolean
}

export const make = (): State => ({
  snapshots: new Map(),
  resync: new Map(),
  latest: new Map(),
  critical: [],
  criticalOverflowed: false,
})

const rememberImpl = (state: State, event: InteractiveEvent) => {
  if (state.criticalOverflowed) return
  if (event._tag === "ThreadViewSnapshot") {
    const id = String(event.snapshot.thread.id)
    if (!state.snapshots.has(id) && state.snapshots.size >= capacity) {
      state.criticalOverflowed = true
      return
    }
    state.snapshots.set(id, event)
    state.resync.delete(id)
    return
  }
  if (event._tag === "ThreadViewPatch") {
    const id = String(event.patch.threadId)
    if (state.snapshots.has(id)) return
    if (!state.resync.has(id) && state.resync.size >= capacity) {
      state.criticalOverflowed = true
      return
    }
    state.resync.set(
      id,
      ThreadView.ResyncRequired.make({
        threadId: event.patch.threadId,
        expectedRevision: event.patch.revision,
        receivedBaseRevision: event.patch.baseRevision,
        currentRevision: event.patch.baseRevision,
      }),
    )
    return
  }
  if (event._tag === "ResyncRequired") {
    const id = String(event.threadId)
    if (!state.resync.has(id) && state.resync.size >= capacity) {
      state.criticalOverflowed = true
      return
    }
    state.resync.set(id, event)
    return
  }
  let latestKey: string | undefined
  switch (event._tag) {
    case "ThreadsListed":
      latestKey = "threads"
      break
    case "ThreadRefolding":
      latestKey = `refolding:${event.threadId}`
      break
    case "QueueFull":
      latestKey = `queue-full:${event.threadId}`
      break
    case "SubmissionAdmitted":
      latestKey = `admitted:${event.threadId}:${event.turnId}`
      break
    case "ThreadTitled":
      latestKey = `title:${event.threadId}`
      break
    case "GoalChanged":
      latestKey = `goal:${event.threadId}`
      break
    case "ThreadActivated":
      latestKey = "activated"
      break
    case "ThreadPreviewLoaded":
    case "ThreadPreviewFailed":
      latestKey = `preview:${event.threadId}`
      break
    case "AssistantCompleted":
    case "ContextDiagnostics":
    case "ExecutionFailed":
    case "ExecutionControlFailed":
    case "ShellCompleted":
    case "ExecutionControlled":
      break
  }
  if (latestKey !== undefined) {
    if (!state.latest.has(latestKey) && state.latest.size >= capacity) state.criticalOverflowed = true
    else state.latest.set(latestKey, event)
    return
  }
  if (state.critical.length >= capacity) state.criticalOverflowed = true
  else state.critical.push(event)
}

export const remember: {
  (event: InteractiveEvent): (state: State) => void
  (state: State, event: InteractiveEvent): void
} = Function.dual(2, rememberImpl)

export const events = (state: State): ReadonlyArray<InteractiveEvent> => [
  ...state.snapshots.values(),
  ...state.resync.values(),
  ...state.latest.values(),
  ...state.critical,
]
