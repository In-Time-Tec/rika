import * as InteractiveEvent from "@rika/product/interactive-event"
import * as TranscriptUnit from "@rika/transcript/transcript-unit"
import { Clock, Effect, Schema } from "effect"
import { selectedThreadMetadata, update } from "@rika/terminal/terminal-state-reducer"
import * as InteractiveController from "../controller/interactive-controller"
import * as ThreadSelection from "../controller/terminal-thread-selection"
import type { InteractiveRuntimeContext } from "./interactive-runtime-context"

type Runtime = Pick<InteractiveRuntimeContext, "loop" | "render"> & {
  readonly refreshTerminalTitle: () => void
  readonly requestSelectionResync: (threadId: string) => void
}

export const makeEventRouter = (runtime: Runtime) => {
  const { loop, refreshTerminalTitle, render, requestSelectionResync } = runtime
  const clearModelPreview = (turnId?: string) => {
    const cleared = InteractiveController.clearPreview(
      {
        model: loop.model,
        ...(loop.threadView === undefined ? {} : { view: loop.threadView }),
        ...(loop.modelPreview === undefined ? {} : { modelPreview: loop.modelPreview }),
      },
      turnId,
    )
    loop.model = cleared.model
    loop.threadView = cleared.view
    loop.modelPreview = cleared.modelPreview
  }
  const dismissCtrlCMenuWhenBusy = () => {
    if (!loop.model.busy || !loop.ctrlCMenuVisible) return
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
      const controlled = InteractiveController.update(
        {
          model: loop.model,
          ...(loop.threadView === undefined ? {} : { view: loop.threadView }),
          ...(loop.modelPreview === undefined ? {} : { modelPreview: loop.modelPreview }),
        },
        event,
      )
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
      if (loop.model.currentThreadId === undefined || loop.model.currentThreadId === event.threadId)
        loop.model = update(loop.model, {
          _tag: "SubmissionAdmitted",
          turnId: event.turnId,
          status: event.status,
          ...(event.submissionId === undefined ? {} : { submissionId: event.submissionId }),
        })
    } else if (event._tag === "SubmissionRejected") {
      if (event.threadId !== undefined && loop.model.currentThreadId !== event.threadId) return
      loop.model = update(loop.model, {
        _tag: "SubmissionRejected",
        message: event.message,
        ...(event.submissionId === undefined ? {} : { submissionId: event.submissionId }),
      })
    } else if (event._tag === "ThreadsListed") {
      loop.model = update(loop.model, {
        _tag: "ThreadsReplaced",
        threads: event.threads.map((thread) => ({
          id: thread.id,
          title: thread.title,
          workspace: thread.workspace,
          pinned: thread.pinned,
          archived: thread.archived,
          status: thread.status,
          unread: thread.unread,
          lastActivityAt: thread.lastActivityAt,
          ...(thread.editTotals === undefined ? {} : { editTotals: thread.editTotals }),
        })),
      })
    } else if (event._tag === "ExecutionControlled") {
      if (event.threadId !== undefined && loop.model.currentThreadId !== event.threadId) return
      if (event.action === "cancelled") {
        clearModelPreview(event.turnId)
        loop.model = update(loop.model, {
          _tag: "ExecutionCancelled",
          ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
          ...(event.agentResponseArrived === undefined ? {} : { agentResponseArrived: event.agentResponseArrived }),
        })
      }
    } else if (event._tag === "ExecutionControlFailed") {
      if (event.threadId !== undefined && loop.model.currentThreadId !== event.threadId) return
      if (event.action === "steer" && event.steeringRequestId !== undefined)
        loop.model = update(loop.model, {
          _tag: "SteeringFailed",
          requestId: event.steeringRequestId,
          message: event.failure.message,
        })
      if (event.action === "cancel")
        loop.model = update(loop.model, {
          _tag: "CancelFailed",
          ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
          message: event.failure.message,
        })
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
      loop.model = update(loop.model, {
        _tag: "ExecutionFailed",
        ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
        failure: event.failure,
      })
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
      loop.model = update(loop.model, {
        _tag: "GoalChanged",
        ...(event.goal === undefined ? {} : { goal: event.goal }),
      })
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
