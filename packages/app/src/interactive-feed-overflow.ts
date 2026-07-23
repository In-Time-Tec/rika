import * as Thread from "@rika/persistence/thread"
import { Function } from "effect"
import type { InteractiveEvent } from "./operation-contract"

export const capacity = 64

export interface State {
  readonly transcriptThreadIds: Set<string>
  readonly queueThreadIds: Set<string>
  readonly critical: Array<InteractiveEvent>
  criticalOverflowed: boolean
  activated?: Extract<InteractiveEvent, { readonly _tag: "ThreadActivated" }>
  summaries?: Extract<InteractiveEvent, { readonly _tag: "ThreadsListed" }>
}

export const make = (): State => ({
  transcriptThreadIds: new Set(),
  queueThreadIds: new Set(),
  critical: [],
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
    case "ExecutionFailed":
    case "QueueFull":
    case "ShellPermissionRequested":
    case "ShellPermissionCancelled":
    case "ShellCompleted":
    case "ExecutionControlled":
    case "TitleCostUpdated":
    case "ThreadTitled":
    case "ThreadPreviewLoaded":
    case "ThreadUsageUpdated":
    case "TranscriptReplaced":
      return true
    case "ThreadsListed":
    case "TranscriptPatched":
    case "TranscriptResyncRequired":
    case "QueueUpdated":
    case "QueueResyncRequired":
    case "TurnStarted":
    case "SubmissionAdmitted":
    case "SelectionLoaded":
    case "TranscriptPagePrepended":
    case "ThreadActivated":
      return false
  }
}

const rememberImpl = (state: State, event: InteractiveEvent) => {
  if (state.criticalOverflowed) return
  const id = threadId(event)
  switch (event._tag) {
    case "TranscriptPatched":
    case "TranscriptResyncRequired":
    case "TurnStarted":
    case "SelectionLoaded":
    case "TranscriptPagePrepended":
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
    case "AssistantCompleted":
    case "ContextDiagnostics":
    case "ExecutionFailed":
    case "QueueFull":
    case "ShellPermissionRequested":
    case "ShellPermissionCancelled":
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
