import * as InteractiveEvent from "@rika/product/interactive-event"
import * as TranscriptUnit from "@rika/transcript/transcript-unit"
import { Effect, Schema } from "effect"
import { selectedThreadMetadata, update } from "@rika/terminal/terminal-state-reducer"
import * as InteractiveController from "../controller/interactive-controller"
import * as ThreadSelection from "../controller/terminal-thread-selection"
import { makeFeedFrameBatcher } from "../controller/interactive-frame-batch"
import type { InteractiveRuntimeContext } from "./interactive-runtime-context"

type Runtime = Pick<InteractiveRuntimeContext, "loop" | "feedTimer" | "session" | "render"> & {
  readonly refreshTerminalTitle: () => void
  readonly requestSelectionResync: (threadId: string) => void
}

export const makeEventRouter = (runtime: Runtime) => {
  const { loop, feedTimer, refreshTerminalTitle, render, requestSelectionResync } = runtime
  const dispatch = (event: InteractiveEvent.InteractiveEvent) => {
    if (loop.closed) return
    if (
      event._tag === "ThreadViewSnapshot" ||
      event._tag === "ThreadViewPatch" ||
      event._tag === "ResyncRequired" ||
      event._tag === "ThreadRefolding"
    ) {
      if (
        event._tag === "ThreadViewSnapshot" &&
        loop.requestedThreadId !== undefined &&
        loop.requestedThreadId !== String(event.snapshot.thread.id)
      )
        return
      const previousThreadId = loop.model.currentThreadId
      const previousThreadTitle = loop.model.currentThreadTitle
      const controlled = InteractiveController.update(
        {
          model: loop.model,
          ...(loop.threadView === undefined ? {} : { view: loop.threadView }),
        },
        event,
      )
      loop.model = controlled.state.model
      loop.threadView = controlled.state.view
      if (event._tag === "ThreadViewSnapshot") {
        loop.requestedThreadId = String(event.snapshot.thread.id)
        loop.transcriptHasOlder = event.snapshot.hasOlder
        loop.transcriptHasNewer = event.snapshot.hasNewer
        loop.transcriptOldestCursor = event.snapshot.source.oldestCursor
        loop.transcriptNewestCursor = event.snapshot.source.newestCursor
        loop.loadingOlder = false
        loop.pendingNewer = undefined
        loop.model = update(loop.model, { _tag: "ThreadOpenCompleted" })
        if (loop.model.currentThreadId !== previousThreadId || loop.model.currentThreadTitle !== previousThreadTitle)
          refreshTerminalTitle()
      }
      if (controlled.resync === true) {
        const threadId = event._tag === "ResyncRequired" ? String(event.threadId) : loop.model.currentThreadId
        if (threadId !== undefined) requestSelectionResync(threadId)
      }
      if (controlled.preserveAnchor) {
        if (loop.applyingFeedBatch) loop.feedPreserveAnchor = true
        else loop.renderer?.surface.update(loop.model, true)
      } else render(event._tag === "ResyncRequired")
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
      if (event.action === "cancelled")
        loop.model = update(loop.model, {
          _tag: "ExecutionCancelled",
          ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
          ...(event.agentResponseArrived === undefined ? {} : { agentResponseArrived: event.agentResponseArrived }),
        })
      if (
        event.action === "steered" &&
        event.turnId !== undefined &&
        event.steeringSequence !== undefined &&
        event.steeringText !== undefined
      )
        loop.model = update(loop.model, {
          _tag: "SteeringAccepted",
          turnId: event.turnId,
          sequence: event.steeringSequence,
          text: event.steeringText,
        })
    } else if (event._tag === "ExecutionControlFailed") {
      if (event.threadId !== undefined && loop.model.currentThreadId !== event.threadId) return
      if (event.action === "steer" && event.turnId !== undefined && event.steeringText !== undefined)
        loop.model = update(loop.model, {
          _tag: "SteeringFailed",
          turnId: event.turnId,
          text: event.steeringText,
          message: event.message,
        })
      if (event.action === "cancel")
        loop.model = update(loop.model, {
          _tag: "CancelFailed",
          ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
          message: event.message,
        })
      if (event.action === "approve" || event.action === "deny")
        loop.renderer?.surface.showToast(
          `${event.action === "approve" ? "Approval" : "Denial"} failed: ${event.message}`,
          "#e06c75",
        )
    } else if (event._tag === "ContextDiagnostics") {
      if (loop.model.currentThreadId !== event.threadId) return
      loop.model = update(loop.model, {
        _tag: "BlockAdded",
        block: { _tag: "Notification", title: "Context resolution", detail: event.messages.join("\n") },
      })
    } else if (event._tag === "ExecutionFailed") {
      if (event.threadId !== undefined && loop.model.currentThreadId !== event.threadId) return
      loop.model = update(loop.model, {
        _tag: "ExecutionFailed",
        ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
        message: event.message,
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
    } else if (event._tag === "ThreadActivated") {
      loop.requestedThreadId = event.threadId
      loop.model = update(loop.model, { _tag: "ThreadActivated", threadId: event.threadId, title: event.title })
      if (loop.model.currentThreadId === event.threadId) refreshTerminalTitle()
    } else if (event._tag === "ThreadPreviewLoaded") {
      if (loop.model.threadSwitcher.open && selectedThreadMetadata(loop.model)?.id === event.threadId)
        loop.model = update(loop.model, {
          _tag: "ThreadPreviewLoaded",
          threadId: event.threadId,
          turns: event.turns.map((turn) => ({
            prompt: turn.prompt,
            units: turn.units.map((unit) => Schema.decodeUnknownSync(TranscriptUnit.Unit)(unit)),
          })),
        })
    } else if (event._tag === "ThreadPreviewFailed") {
      if (loop.model.threadSwitcher.open && selectedThreadMetadata(loop.model)?.id === event.threadId)
        loop.model = update(loop.model, event)
    } else if (event._tag === "AssistantCompleted") loop.model = update(loop.model, event)
    if (!loop.model.busy && loop.model.activeTurnId === undefined && loop.model.activity === undefined)
      loop.submittedSinceIdle = false
    render(
      event._tag === "ContextDiagnostics" ||
        event._tag === "ExecutionFailed" ||
        event._tag === "QueueFull" ||
        event._tag === "ExecutionControlled",
    )
  }
  const feedBatcher = makeFeedFrameBatcher<InteractiveEvent.InteractiveEvent>({
    schedule: (flush) => {
      feedTimer(Effect.sleep("16 millis").pipe(Effect.andThen(Effect.sync(flush))))
    },
    apply: (events) => {
      loop.applyingFeedBatch = true
      try {
        for (const event of events) dispatch(event)
      } finally {
        loop.applyingFeedBatch = false
      }
    },
    render: () => {
      if (loop.renderer !== undefined && !loop.renderSuppressed)
        loop.renderer.surface.update(loop.model, loop.feedPreserveAnchor)
      loop.feedPreserveAnchor = false
    },
  })
  return { dispatch, feedBatcher }
}
