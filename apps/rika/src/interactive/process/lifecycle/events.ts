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
  const dispatch = (event: InteractiveEvent.InteractiveEvent) => {
    if (loop.closed) return
    if (
      event._tag === "ThreadViewSnapshot" ||
      event._tag === "ThreadViewPatch" ||
      event._tag === "ResyncRequired" ||
      event._tag === "ThreadRefolding" ||
      event._tag === "ExecutionModelPreviewChanged"
    ) {
      const acceptsCreatedThread =
        event._tag === "ThreadViewSnapshot" &&
        loop.newThreadSelectionGeneration !== undefined &&
        loop.requestedThreadId !== String(event.snapshot.thread.id) &&
        loop.model.currentThreadId !== String(event.snapshot.thread.id)
      if (
        event._tag === "ThreadViewSnapshot" &&
        loop.requestedThreadId !== undefined &&
        loop.requestedThreadId !== String(event.snapshot.thread.id) &&
        !acceptsCreatedThread
      )
        return
      const previousThreadId = loop.model.currentThreadId
      const previousThreadTitle = loop.model.currentThreadTitle
      const submittedDrafts = acceptsCreatedThread ? loop.model.submittedDrafts : undefined
      const controlled = InteractiveController.update(controllerState(), event)
      loop.model = controlled.state.model
      loop.threadView = controlled.state.view
      loop.modelPreview = controlled.state.modelPreview
      if (submittedDrafts !== undefined) loop.model = { ...loop.model, submittedDrafts }
      if (event._tag === "ThreadViewSnapshot") {
        loop.requestedThreadId = String(event.snapshot.thread.id)
        if (loop.model.currentThreadId !== previousThreadId) loop.newThreadSelectionGeneration = undefined
        loop.model = update(loop.model, { _tag: "ThreadOpenCompleted" })
        if (loop.model.currentThreadId !== previousThreadId || loop.model.currentThreadTitle !== previousThreadTitle)
          refreshTerminalTitle()
      }
      if (controlled.resync === true) {
        const threadId = event._tag === "ResyncRequired" ? String(event.threadId) : loop.model.currentThreadId
        if (threadId !== undefined) requestSelectionResync(threadId)
      }
      dismissCtrlCMenuWhenBusy()
      if (controlled.preserveAnchor) loop.renderer?.surface.update(loop.model, true)
      else render(event._tag === "ResyncRequired")
      if (!loop.model.busy && loop.model.activeTurnId === undefined && loop.model.activity === undefined)
        loop.submittedSinceIdle = false
      return
    }
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
    } else if (event._tag === "SubmissionRejected") {
      if (event.threadId !== undefined && loop.model.currentThreadId !== event.threadId) return
      const action: TerminalMessage = {
        _tag: "SubmissionRejected",
        message: event.message,
      }
      if (event.submissionId !== undefined) action.submissionId = event.submissionId
      loop.model = update(loop.model, action)
    } else if (event._tag === "ThreadsListed") {
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
    } else if (event._tag === "ExecutionControlled") {
      if (event.threadId !== undefined && loop.model.currentThreadId !== event.threadId) return
      if (event.action === "cancelled") {
        clearModelPreview(event.turnId)
        const action: TerminalMessage = {
          _tag: "ExecutionCancelled",
        }
        if (event.turnId !== undefined) action.turnId = event.turnId
        if (event.agentResponseArrived !== undefined) action.agentResponseArrived = event.agentResponseArrived
        loop.model = update(loop.model, action)
      }
    } else if (event._tag === "ExecutionControlFailed") {
      if (event.threadId !== undefined && loop.model.currentThreadId !== event.threadId) return
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
    } else if (event._tag === "ContextDiagnostics") {
      if (loop.model.currentThreadId !== event.threadId) return
      loop.model = update(loop.model, {
        _tag: "BlockAdded",
        block: { _tag: "Notification", title: "Context resolution", detail: event.messages.join("\n") },
      })
    } else if (event._tag === "TurnRetryScheduled") {
      if (loop.model.currentThreadId !== event.threadId) return
      loop.model = update(loop.model, {
        _tag: "TurnRetryScheduled",
        turnId: event.turnId,
        attempt: event.attempt,
        budget: event.budget,
        message: event.message,
        nextAt: event.nextAt,
        retryCountdown: Math.max(0, Math.ceil((event.nextAt - Effect.runSync(Clock.currentTimeMillis)) / 1000)),
      })
    } else if (event._tag === "ExecutionFailed") {
      if (event.threadId !== undefined && loop.model.currentThreadId !== event.threadId) return
      clearModelPreview(event.turnId)
      const action: TerminalMessage = {
        _tag: "ExecutionFailed",
        failure: event.failure,
      }
      if (event.turnId !== undefined) action.turnId = event.turnId
      loop.model = update(loop.model, action)
    } else if (event._tag === "QueueFull") {
      if (loop.model.currentThreadId !== undefined && loop.model.currentThreadId !== event.threadId) return
      loop.model = ThreadSelection.updateQueue(loop.model, event).model
    } else if (event._tag === "ShellCompleted") {
      if (loop.model.currentThreadId !== event.threadId) return
      if (event.incognito) loop.model = update(loop.model, { _tag: "AssistantCompleted", text: event.text })
      loop.model = update(loop.model, { _tag: "ExecutionCompleted" })
    } else if (event._tag === "ThreadTitled") {
      loop.model = update(loop.model, { _tag: "ThreadTitleChanged", threadId: event.threadId, title: event.title })
      if (loop.model.currentThreadId === event.threadId) refreshTerminalTitle()
    } else if (event._tag === "GoalChanged") {
      if (loop.model.currentThreadId !== event.threadId) return
      const action: TerminalMessage = { _tag: "GoalChanged" }
      if (event.goal !== undefined) action.goal = event.goal
      loop.model = update(loop.model, action)
    } else if (event._tag === "ThreadActivated") {
      loop.requestedThreadId = event.threadId
      loop.newThreadSelectionGeneration = undefined
      loop.model = update(loop.model, { _tag: "ThreadActivated", threadId: event.threadId, title: event.title })
      if (loop.model.currentThreadId === event.threadId) refreshTerminalTitle()
    } else if (event._tag === "ThreadPreviewLoaded") {
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
    } else if (event._tag === "AssistantCompleted") loop.model = update(loop.model, event)
    dismissCtrlCMenuWhenBusy()
    if (!loop.model.busy && loop.model.activeTurnId === undefined && loop.model.activity === undefined)
      loop.submittedSinceIdle = false
    render(
      event._tag === "ContextDiagnostics" ||
        event._tag === "TurnRetryScheduled" ||
        event._tag === "ExecutionFailed" ||
        event._tag === "SubmissionRejected" ||
        event._tag === "QueueFull" ||
        event._tag === "ExecutionControlled",
    )
  }
  return { dispatch }
}
