import * as InteractiveEvent from "@rika/product/interactive-event"
import * as TranscriptUnit from "@rika/transcript/transcript-unit"
import { Clock, Effect, Schema } from "effect"
import { selectedThreadMetadata, update } from "@rika/terminal/terminal-state-reducer"
import * as InteractiveController from "../../controller/service"
import * as ThreadSelection from "../../controller/thread-selection"
import type { InteractiveLoop } from "../runtime/context"

type EventLoop = Pick<
  InteractiveLoop,
  "closed" | "model" | "renderer" | "submittedSinceIdle" | "threadView" | "modelPreview" | "requestedThreadId"
> &
  Partial<Pick<InteractiveLoop, "newThreadSelectionGeneration" | "ctrlCMenuVisible">>

type Runtime = {
  readonly loop: EventLoop
  readonly render: (immediate?: boolean) => void
  readonly refreshTerminalTitle: () => void
  readonly requestSelectionResync: (threadId: string) => void
}
type Mutable<T> = { -readonly [P in keyof T]: T[P] }
type ControllerState = Mutable<InteractiveController.State>
type TerminalMessage = Mutable<Parameters<typeof update>[0]>
type InteractiveEventType = InteractiveEvent.InteractiveEvent
type EventWithTag<Tag extends InteractiveEventType["_tag"]> = Extract<InteractiveEventType, { readonly _tag: Tag }>
type ControllerEvent = EventWithTag<
  "ThreadViewSnapshot" | "ThreadViewPatch" | "ResyncRequired" | "ThreadRefolding" | "ExecutionModelPreviewChanged"
>
type SubmissionEvent = EventWithTag<"SubmissionAdmitted" | "SubmissionRejected" | "QueueFull">
type ExecutionOutcomeEvent = EventWithTag<
  "ExecutionFailed" | "TurnRetryScheduled" | "ShellCompleted" | "AssistantCompleted"
>
type ThreadDataEvent = EventWithTag<"ThreadsListed" | "ContextDiagnostics">
type ThreadIdentityEvent = EventWithTag<"ThreadTitled" | "ThreadActivated">
type ThreadPreviewEvent = EventWithTag<"ThreadPreviewLoaded" | "ThreadPreviewFailed">

const isControllerEvent = (event: InteractiveEventType): event is ControllerEvent =>
  event._tag === "ThreadViewSnapshot" ||
  event._tag === "ThreadViewPatch" ||
  event._tag === "ResyncRequired" ||
  event._tag === "ThreadRefolding" ||
  event._tag === "ExecutionModelPreviewChanged"

const isSubmissionEvent = (event: InteractiveEventType): event is SubmissionEvent =>
  event._tag === "SubmissionAdmitted" || event._tag === "SubmissionRejected" || event._tag === "QueueFull"

const isExecutionOutcomeEvent = (event: InteractiveEventType): event is ExecutionOutcomeEvent =>
  event._tag === "ExecutionFailed" ||
  event._tag === "TurnRetryScheduled" ||
  event._tag === "ShellCompleted" ||
  event._tag === "AssistantCompleted"

const isThreadDataEvent = (event: InteractiveEventType): event is ThreadDataEvent =>
  event._tag === "ThreadsListed" || event._tag === "ContextDiagnostics"

const isThreadIdentityEvent = (event: InteractiveEventType): event is ThreadIdentityEvent =>
  event._tag === "ThreadTitled" || event._tag === "ThreadActivated"

const isThreadPreviewEvent = (event: InteractiveEventType): event is ThreadPreviewEvent =>
  event._tag === "ThreadPreviewLoaded" || event._tag === "ThreadPreviewFailed"

export const makeEventRouter = (runtime: Runtime) => {
  const { loop, refreshTerminalTitle, render, requestSelectionResync } = runtime
  const controllerState = () => {
    const state: ControllerState = {
      model: loop.model,
    }
    if (loop.threadView !== undefined) state.view = loop.threadView
    if (loop.modelPreview !== undefined) state.modelPreview = loop.modelPreview
    return state
  }
  const clearModelPreview = (turnId?: string) => {
    const cleared = InteractiveController.clearPreview(controllerState(), turnId)
    loop.model = cleared.model
    loop.threadView = cleared.view
    loop.modelPreview = cleared.modelPreview
  }
  const dismissCtrlCMenuWhenBusy = () => {
    if (!loop.model.busy || loop.ctrlCMenuVisible !== true) return
    loop.ctrlCMenuVisible = false
    loop.renderer?.surface.showCtrlCMenu(false)
  }
  const settleIdleState = () => {
    if (!loop.model.busy && loop.model.activeTurnId === undefined && loop.model.activity === undefined)
      loop.submittedSinceIdle = false
  }
  const acceptsCreatedThread = (event: ControllerEvent) =>
    event._tag === "ThreadViewSnapshot" &&
    loop.newThreadSelectionGeneration !== undefined &&
    loop.requestedThreadId !== String(event.snapshot.thread.id) &&
    loop.model.currentThreadId !== String(event.snapshot.thread.id)
  const ignoresSnapshot = (event: ControllerEvent, acceptsCreated: boolean) =>
    event._tag === "ThreadViewSnapshot" &&
    loop.requestedThreadId !== undefined &&
    loop.requestedThreadId !== String(event.snapshot.thread.id) &&
    !acceptsCreated
  const completeSnapshot = (
    event: EventWithTag<"ThreadViewSnapshot">,
    previousThreadId: string | undefined,
    previousThreadTitle: string | undefined,
  ) => {
    loop.requestedThreadId = String(event.snapshot.thread.id)
    if (loop.model.currentThreadId !== previousThreadId) loop.newThreadSelectionGeneration = undefined
    loop.model = update(loop.model, { _tag: "ThreadOpenCompleted" })
    if (loop.model.currentThreadId !== previousThreadId || loop.model.currentThreadTitle !== previousThreadTitle)
      refreshTerminalTitle()
  }
  const routeControllerEvent = (event: ControllerEvent) => {
    const acceptsCreated = acceptsCreatedThread(event)
    if (ignoresSnapshot(event, acceptsCreated)) return
    const previousThreadId = loop.model.currentThreadId
    const previousThreadTitle = loop.model.currentThreadTitle
    const submittedDrafts = acceptsCreated ? loop.model.submittedDrafts : undefined
    const controlled = InteractiveController.update(controllerState(), event)
    loop.model = controlled.state.model
    loop.threadView = controlled.state.view
    loop.modelPreview = controlled.state.modelPreview
    if (submittedDrafts !== undefined) loop.model = { ...loop.model, submittedDrafts }
    if (event._tag === "ThreadViewSnapshot") completeSnapshot(event, previousThreadId, previousThreadTitle)
    if (controlled.resync === true) {
      const threadId = event._tag === "ResyncRequired" ? String(event.threadId) : loop.model.currentThreadId
      if (threadId !== undefined) requestSelectionResync(threadId)
    }
    dismissCtrlCMenuWhenBusy()
    if (controlled.preserveAnchor) loop.renderer?.surface.update(loop.model, true)
    else render(event._tag === "ResyncRequired")
    settleIdleState()
  }
  const routeSubmissionEvent = (event: SubmissionEvent): boolean => {
    if (event._tag === "SubmissionAdmitted") {
      if (loop.model.currentThreadId === undefined || loop.model.currentThreadId === event.threadId) {
        const action: TerminalMessage = {
          _tag: "SubmissionAdmitted",
          turnId: event.turnId,
          status: event.status,
        }
        if (event.submissionId !== undefined) action.submissionId = event.submissionId
        loop.model = update(loop.model, action)
      }
      return true
    }
    if (event._tag === "SubmissionRejected") {
      if (event.threadId !== undefined && loop.model.currentThreadId !== event.threadId) return false
      const action: TerminalMessage = {
        _tag: "SubmissionRejected",
        message: event.message,
      }
      if (event.submissionId !== undefined) action.submissionId = event.submissionId
      loop.model = update(loop.model, action)
      return true
    }
    if (loop.model.currentThreadId !== undefined && loop.model.currentThreadId !== event.threadId) return false
    loop.model = ThreadSelection.updateQueue(loop.model, event).model
    return true
  }
  const routeExecutionControlled = (event: EventWithTag<"ExecutionControlled">): boolean => {
    if (event.threadId !== undefined && loop.model.currentThreadId !== event.threadId) return false
    if (event.action === "cancelled") {
      clearModelPreview(event.turnId)
      const action: TerminalMessage = {
        _tag: "ExecutionCancelled",
      }
      if (event.turnId !== undefined) action.turnId = event.turnId
      if (event.agentResponseArrived !== undefined) action.agentResponseArrived = event.agentResponseArrived
      loop.model = update(loop.model, action)
    }
    return true
  }
  const routeExecutionControlFailed = (event: EventWithTag<"ExecutionControlFailed">): boolean => {
    if (event.threadId !== undefined && loop.model.currentThreadId !== event.threadId) return false
    if (event.action === "steer" && event.steeringRequestId !== undefined)
      loop.model = update(loop.model, {
        _tag: "SteeringFailed",
        requestId: event.steeringRequestId,
        message: event.failure.message,
      })
    if (event.action === "cancel") {
      const action: TerminalMessage = {
        _tag: "CancelFailed",
        message: event.failure.message,
      }
      if (event.turnId !== undefined) action.turnId = event.turnId
      loop.model = update(loop.model, action)
    }
    if (event.action === "approve" || event.action === "deny")
      loop.model = update(loop.model, {
        _tag: "BlockAdded",
        block: {
          _tag: "Error",
          title: `${event.action === "approve" ? "Approval" : "Denial"} failed`,
          detail: event.failure.message,
        },
      })
    return true
  }
  const routeExecutionOutcomeEvent = (event: ExecutionOutcomeEvent): boolean => {
    if (event._tag === "TurnRetryScheduled") {
      if (loop.model.currentThreadId !== event.threadId) return false
      loop.model = update(loop.model, {
        _tag: "TurnRetryScheduled",
        turnId: event.turnId,
        attempt: event.attempt,
        budget: event.budget,
        message: event.message,
        nextAt: event.nextAt,
        retryCountdown: Math.max(0, Math.ceil((event.nextAt - Effect.runSync(Clock.currentTimeMillis)) / 1000)),
      })
      return true
    }
    if (event._tag === "ExecutionFailed") {
      if (event.threadId !== undefined && loop.model.currentThreadId !== event.threadId) return false
      clearModelPreview(event.turnId)
      const action: TerminalMessage = {
        _tag: "ExecutionFailed",
        failure: event.failure,
      }
      if (event.turnId !== undefined) action.turnId = event.turnId
      loop.model = update(loop.model, action)
      return true
    }
    if (event._tag === "ShellCompleted") {
      if (loop.model.currentThreadId !== event.threadId) return false
      if (event.incognito) loop.model = update(loop.model, { _tag: "AssistantCompleted", text: event.text })
      loop.model = update(loop.model, { _tag: "ExecutionCompleted" })
      return true
    }
    loop.model = update(loop.model, event)
    return true
  }
  const routeThreadDataEvent = (event: ThreadDataEvent): boolean => {
    if (event._tag === "ThreadsListed") {
      loop.model = update(loop.model, {
        _tag: "ThreadsReplaced",
        threads: event.threads.map((thread) => {
          const item = {
            id: thread.id,
            title: thread.title,
            workspace: thread.workspace,
            pinned: thread.pinned,
            archived: thread.archived,
            status: thread.status,
            unread: thread.unread,
            lastActivityAt: thread.lastActivityAt,
          }
          return thread.editTotals === undefined ? item : { ...item, editTotals: thread.editTotals }
        }),
      })
    } else if (event._tag === "ContextDiagnostics") {
      if (loop.model.currentThreadId !== event.threadId) return false
      loop.model = update(loop.model, {
        _tag: "BlockAdded",
        block: { _tag: "Notification", title: "Context resolution", detail: event.messages.join("\n") },
      })
    }
    return true
  }
  const routeThreadIdentityEvent = (event: ThreadIdentityEvent) => {
    if (event._tag === "ThreadTitled") {
      loop.model = update(loop.model, { _tag: "ThreadTitleChanged", threadId: event.threadId, title: event.title })
      if (loop.model.currentThreadId === event.threadId) refreshTerminalTitle()
    } else {
      loop.requestedThreadId = event.threadId
      loop.newThreadSelectionGeneration = undefined
      loop.model = update(loop.model, { _tag: "ThreadActivated", threadId: event.threadId, title: event.title })
      if (loop.model.currentThreadId === event.threadId) refreshTerminalTitle()
    }
    return true
  }
  const routeThreadPreviewEvent = (event: ThreadPreviewEvent) => {
    if (event._tag === "ThreadPreviewLoaded") {
      if (loop.model.threadSwitcher.open && selectedThreadMetadata(loop.model)?.id === event.threadId)
        loop.model = update(loop.model, {
          _tag: "ThreadPreviewLoaded",
          threadId: event.threadId,
          requestId: event.requestId,
          units: event.units.map((unit) => Schema.decodeUnknownSync(TranscriptUnit.Unit)(unit)),
        })
    } else if (event._tag === "ThreadPreviewFailed") {
      if (loop.model.threadSwitcher.open && selectedThreadMetadata(loop.model)?.id === event.threadId)
        loop.model = update(loop.model, event)
    }
    return true
  }
  const renderImmediately = (event: InteractiveEventType) =>
    event._tag === "ContextDiagnostics" ||
    event._tag === "TurnRetryScheduled" ||
    event._tag === "ExecutionFailed" ||
    event._tag === "SubmissionRejected" ||
    event._tag === "QueueFull" ||
    event._tag === "ExecutionControlled"
  const dispatch = (event: InteractiveEventType) => {
    if (loop.closed) return
    if (isControllerEvent(event)) {
      routeControllerEvent(event)
      return
    }
    let accepted = true
    if (isSubmissionEvent(event)) accepted = routeSubmissionEvent(event)
    else if (event._tag === "ExecutionControlled") accepted = routeExecutionControlled(event)
    else if (event._tag === "ExecutionControlFailed") accepted = routeExecutionControlFailed(event)
    else if (isExecutionOutcomeEvent(event)) accepted = routeExecutionOutcomeEvent(event)
    else if (isThreadDataEvent(event)) accepted = routeThreadDataEvent(event)
    else if (isThreadIdentityEvent(event)) accepted = routeThreadIdentityEvent(event)
    else if (isThreadPreviewEvent(event)) accepted = routeThreadPreviewEvent(event)
    if (!accepted) return
    dismissCtrlCMenuWhenBusy()
    settleIdleState()
    render(renderImmediately(event))
  }
  return { dispatch }
}
