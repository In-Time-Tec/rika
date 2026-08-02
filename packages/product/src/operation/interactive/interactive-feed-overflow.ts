import * as Thread from "@rika/product/thread-record"
import { Function } from "effect"
import type { InteractiveEvent } from "./interactive-event"

export const capacity = 64

export interface State {
  readonly transcriptThreadIds: Set<string>
  readonly queueThreadIds: Set<string>
  readonly critical: Array<InteractiveEvent>
  readonly settlements: Map<string, Extract<InteractiveEvent, { readonly _tag: "TurnSettled" }>>
  readonly usage: Map<string, Extract<InteractiveEvent, { readonly _tag: "ThreadUsageUpdated" }>>
  readonly refolds: Map<string, Extract<InteractiveEvent, { readonly _tag: "ThreadRefolding" }>>
  criticalOverflowed: boolean
  activated?: Extract<InteractiveEvent, { readonly _tag: "ThreadActivated" }>
  summaries?: Extract<InteractiveEvent, { readonly _tag: "ThreadsListed" }>
}

export const make = (): State => ({
  transcriptThreadIds: new Set(),
  queueThreadIds: new Set(),
  critical: [],
  settlements: new Map(),
  usage: new Map(),
  refolds: new Map(),
  criticalOverflowed: false,
})

const threadId = (event: InteractiveEvent): string | undefined => {
  if (event._tag === "SelectionLoaded") return String(event.thread.id)
  if ("threadId" in event && event.threadId !== undefined) return String(event.threadId)
  return undefined
}

const rememberThread = (state: State, threadIds: Set<string>, id: string) => {
  if (threadIds.has(id)) return
  if (threadIds.size >= capacity) {
    state.criticalOverflowed = true
    return
  }
  threadIds.add(id)
}

export const isCritical = (event: InteractiveEvent): boolean => {
  switch (event._tag) {
    case "AssistantCompleted":
    case "ContextDiagnostics":
    case "ExecutionControlFailed":
    case "ExecutionFailed":
    case "QueueFull":
    case "ShellCompleted":
    case "ExecutionControlled":
    case "TitleCostUpdated":
    case "ThreadTitled":
    case "ThreadPreviewLoaded":
    case "ThreadUsageUpdated":
    case "TurnSettled":
      return true
    case "ThreadsListed":
    case "ThreadRefolding":
    case "TranscriptProjectionStarted":
    case "TranscriptProjectionPatched":
    case "TranscriptProjectionStopped":
    case "TranscriptProjectionFailed":
    case "TranscriptResyncRequired":
    case "QueueUpdated":
    case "QueueResyncRequired":
    case "TurnStarted":
    case "SubmissionAdmitted":
    case "SelectionLoaded":
    case "TranscriptPagePrepended":
    case "TranscriptPageAppended":
    case "ThreadActivated":
      return false
  }
}

const rememberImpl = (state: State, event: InteractiveEvent) => {
  if (event._tag === "TurnSettled") {
    const key = `${event.threadId}:${event.turnId}`
    const previous = state.settlements.get(key)
    if (previous === undefined || previous.activitySequence < event.activitySequence) state.settlements.set(key, event)
    return
  }
  if (state.criticalOverflowed) return
  const id = threadId(event)
  switch (event._tag) {
    case "TranscriptProjectionStarted":
    case "TranscriptProjectionPatched":
    case "TranscriptProjectionStopped":
    case "TranscriptProjectionFailed":
    case "TranscriptResyncRequired":
    case "TurnStarted":
    case "SelectionLoaded":
    case "TranscriptPagePrepended":
    case "TranscriptPageAppended":
      if (id !== undefined) rememberThread(state, state.transcriptThreadIds, id)
      return
    case "QueueUpdated":
    case "QueueResyncRequired":
      if (id !== undefined) rememberThread(state, state.queueThreadIds, id)
      return
    case "ThreadActivated":
      state.activated = event
      return
    case "ThreadsListed":
      state.summaries = event
      return
    case "ThreadUsageUpdated":
      if (id !== undefined) state.usage.set(id, event)
      return
    case "ThreadRefolding":
      if (id !== undefined) state.refolds.set(id, event)
      return
    case "AssistantCompleted":
    case "ContextDiagnostics":
    case "ExecutionControlFailed":
    case "ExecutionFailed":
    case "QueueFull":
    case "ShellCompleted":
    case "ExecutionControlled":
    case "TitleCostUpdated":
    case "ThreadTitled":
    case "ThreadPreviewLoaded":
      if (state.critical.length >= capacity) state.criticalOverflowed = true
      else state.critical.push(event)
  }
}

export const remember: {
  (event: InteractiveEvent): (state: State) => void
  (state: State, event: InteractiveEvent): void
} = Function.dual(2, rememberImpl)

const eventsImpl = (state: State, selectionEpoch: number, reason: string): ReadonlyArray<InteractiveEvent> => {
  const recovered: Array<InteractiveEvent> = []
  if (state.activated !== undefined) recovered.push(state.activated)
  if (state.summaries !== undefined) recovered.push(state.summaries)
  recovered.push(...state.critical)
  recovered.push(
    ...[...state.settlements.values()].toSorted((left, right) => left.activitySequence - right.activitySequence),
  )
  recovered.push(...state.usage.values())
  recovered.push(...state.refolds.values())
  for (const id of state.transcriptThreadIds)
    recovered.push({
      _tag: "TranscriptResyncRequired",
      selectionEpoch,
      threadId: Thread.ThreadId.make(id),
      reason,
    })
  for (const id of state.queueThreadIds)
    recovered.push({
      _tag: "QueueResyncRequired",
      selectionEpoch,
      threadId: Thread.ThreadId.make(id),
      reason,
    })
  return recovered
}

export const events: {
  (selectionEpoch: number, reason: string): (state: State) => ReadonlyArray<InteractiveEvent>
  (state: State, selectionEpoch: number, reason: string): ReadonlyArray<InteractiveEvent>
} = Function.dual(3, eventsImpl)
