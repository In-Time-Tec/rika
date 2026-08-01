import * as InteractiveEvent from "@rika/product/interactive-event"
import * as TranscriptProjection from "@rika/transcript/transcript-projection"
import * as TranscriptUnit from "@rika/transcript/transcript-unit"
import { Effect, Schema } from "effect"
import type { ThreadItem } from "@rika/terminal/terminal-message"
import { selectedThreadMetadata, update } from "@rika/terminal/terminal-state-reducer"
import * as InteractiveController from "../controller/interactive-controller"
import * as ThreadSelection from "../controller/terminal-thread-selection"
import { makeFeedFrameBatcher } from "../controller/interactive-frame-batch"

type Runtime = any

export const makeEventRouter = (runtime: Runtime) => {
  const {
    loop,
    fork,
    session,
    refreshTerminalTitle,
    traceTuiModelEvent,
    render,
    requestSelectionResync,
    requestQueueResync,
  } = runtime
  const dispatch = (event: InteractiveEvent.InteractiveEvent) => {
    if (loop.closed) return
    if (
      event._tag === "SelectionLoaded" ||
      event._tag === "TranscriptPagePrepended" ||
      event._tag === "TranscriptPageAppended" ||
      event._tag === "TranscriptProjectionStarted" ||
      event._tag === "TranscriptProjectionPatched" ||
      event._tag === "TranscriptProjectionStopped" ||
      event._tag === "TranscriptProjectionFailed" ||
      event._tag === "TranscriptResyncRequired" ||
      event._tag === "ThreadUsageUpdated" ||
      event._tag === "ThreadRefolding"
    ) {
      const selectionStartedAt = event._tag === "SelectionLoaded" ? performance.now() : undefined
      const previousThreadId = loop.model.currentThreadId
      const previousThreadTitle = loop.model.currentThreadTitle
      const controlled = InteractiveController.update(
        {
          model: loop.model,
          selectionEpoch: loop.activeSelectionEpoch,
          replayTurns: loop.replayTurns,
          entries: loop.loadedTranscriptEntries,
          revisions: loop.projectionRevisions,
          liveProjections: loop.liveTranscriptProjections,
          projectionStreams: loop.projectionStreams,
          ...(loop.threadCostUsd === undefined ? {} : { threadCostUsd: loop.threadCostUsd }),
          ...(loop.lastAvailableUsageCost === undefined ? {} : { lastAvailableUsageCost: loop.lastAvailableUsageCost }),
          hasOlder: loop.transcriptHasOlder,
          hasNewer: loop.transcriptHasNewer,
          ...(loop.transcriptOldestCursor === undefined ? {} : { oldestCursor: loop.transcriptOldestCursor }),
          ...(loop.transcriptNewestCursor === undefined ? {} : { newestCursor: loop.transcriptNewestCursor }),
        },
        event,
      )
      loop.model = controlled.state.model
      loop.activeSelectionEpoch = controlled.state.selectionEpoch
      loop.replayTurns = new Map(controlled.state.replayTurns)
      loop.loadedTranscriptEntries = controlled.state.entries
      loop.projectionRevisions = new Map(controlled.state.revisions)
      loop.liveTranscriptProjections = new Map(controlled.state.liveProjections)
      loop.projectionStreams = new Map(controlled.state.projectionStreams)
      loop.threadCostUsd = controlled.state.threadCostUsd
      loop.lastAvailableUsageCost = controlled.state.lastAvailableUsageCost
      loop.transcriptHasOlder = controlled.state.hasOlder ?? false
      loop.transcriptHasNewer = controlled.state.hasNewer ?? false
      loop.transcriptOldestCursor = controlled.state.oldestCursor
      loop.transcriptNewestCursor = controlled.state.newestCursor
      if (event._tag === "SelectionLoaded") {
        loop.loadingOlder = false
        loop.pendingNewer = undefined
      } else if (
        event._tag === "TranscriptPageAppended" &&
        loop.pendingNewer?.threadId === event.threadId &&
        loop.pendingNewer.selectionEpoch === event.selectionEpoch &&
        loop.pendingNewer.cursor === JSON.stringify(event.requestedAfter)
      )
        loop.pendingNewer = undefined
      if (
        event._tag === "SelectionLoaded" &&
        loop.model.currentThreadId === event.thread.id &&
        (loop.model.currentThreadId !== previousThreadId || loop.model.currentThreadTitle !== previousThreadTitle)
      )
        refreshTerminalTitle()
      if (event._tag === "TranscriptProjectionPatched") fork(traceTuiModelEvent(loop.appliedDeltas, event))
      if (
        (event._tag === "TranscriptResyncRequired" || controlled.resync === true) &&
        loop.model.currentThreadId !== undefined
      )
        requestSelectionResync(loop.model.currentThreadId, event.selectionEpoch)
      if (controlled.preserveAnchor) {
        if (loop.applyingFeedBatch) loop.feedPreserveAnchor = true
        else loop.renderer?.surface.update(loop.model, true)
      } else
        render(
          event._tag === "TranscriptResyncRequired" ||
            event._tag === "TranscriptProjectionStopped" ||
            event._tag === "TranscriptProjectionFailed",
        )
      if (selectionStartedAt !== undefined && event._tag === "SelectionLoaded")
        fork(
          (controlled.discarded === true
            ? Effect.logWarning("tui.selection.discarded")
            : Effect.logInfo("tui.selection.applied")
          ).pipe(
            Effect.annotateLogs({
              "rika.thread.id": String(event.thread.id),
              "rika.transcript.page.units": event.entries.length,
              "rika.duration.ms": Math.round(performance.now() - selectionStartedAt),
            }),
          ),
        )
      if (!loop.model.busy && loop.model.activeTurnId === undefined && loop.model.activity === undefined)
        loop.submittedSinceIdle = false
      return
    }
    if (event._tag === "QueueUpdated") {
      if (
        event.selectionEpoch === loop.activeSelectionEpoch &&
        (loop.model.currentThreadId === undefined || loop.model.currentThreadId === event.threadId)
      ) {
        const updated = ThreadSelection.updateQueue(loop.model, event)
        loop.model = updated.model
        if (updated.resync) requestQueueResync(event.threadId)
      }
    } else if (event._tag === "QueueResyncRequired") {
      if (
        event.selectionEpoch === loop.activeSelectionEpoch &&
        (loop.model.currentThreadId === undefined || loop.model.currentThreadId === event.threadId)
      )
        requestQueueResync(event.threadId)
    } else if (event._tag === "TurnStarted") {
      if (
        event.selectionEpoch === loop.activeSelectionEpoch &&
        (loop.model.currentThreadId === undefined || loop.model.currentThreadId === event.threadId)
      ) {
        const known = loop.replayTurns.get(event.turn.id)
        if (
          known?.status === "completed" ||
          known?.status === "failed" ||
          known?.status === "cancelled" ||
          loop.model.activeTurnId === event.turn.id
        )
          return
        if (loop.model.queue.some((item: ThreadItem) => item.id === event.turn.id)) {
          loop.model = ThreadSelection.removePromotedTurn(loop.model, event.threadId, event.turn.id)
          fork(session.readQueue(event.threadId))
        }
        loop.replayTurns.set(event.turn.id, event.turn)
        const seed = TranscriptProjection.Projection.empty(event.turn.id, event.turn.prompt)
        loop.loadedTranscriptEntries = [
          ...loop.loadedTranscriptEntries,
          ...seed.units.map((unit) => ({
            turn: event.turn,
            unit,
            projectionRevision: seed.revision,
            projectionModelPhase: seed.modelPhase,
          })),
        ]
        loop.model = update(loop.model, {
          _tag: "TurnStarted",
          turnId: event.turn.id,
          prompt: event.turn.prompt,
          ...(event.submissionId === undefined ? {} : { submissionId: event.submissionId }),
        })
      }
    } else if (event._tag === "SubmissionAdmitted") {
      if (
        event.selectionEpoch === loop.activeSelectionEpoch &&
        (loop.model.currentThreadId === undefined || loop.model.currentThreadId === event.threadId)
      )
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
      if (event.threadId !== undefined && event.selectionEpoch !== loop.activeSelectionEpoch) return
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
      if (event.threadId !== undefined && event.selectionEpoch !== loop.activeSelectionEpoch) return
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
    } else if (event._tag === "ContextDiagnostics") {
      if (event.selectionEpoch !== loop.activeSelectionEpoch) return
      if (loop.model.currentThreadId !== event.threadId) return
      loop.model = update(loop.model, {
        _tag: "BlockAdded",
        block: {
          _tag: "Notification",
          title: "Context resolution",
          detail: event.messages.join("\n"),
        },
      })
    } else if (event._tag === "ExecutionFailed") {
      if (event.threadId !== undefined && event.selectionEpoch !== loop.activeSelectionEpoch) return
      if (event.threadId !== undefined && loop.model.currentThreadId !== event.threadId) return
      loop.model = update(loop.model, {
        _tag: "ExecutionFailed",
        ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
        message: event.message,
      })
    } else if (event._tag === "QueueFull") {
      if (event.selectionEpoch !== loop.activeSelectionEpoch) return
      if (loop.model.currentThreadId !== undefined && loop.model.currentThreadId !== event.threadId) return
      loop.model = ThreadSelection.updateQueue(loop.model, event).model
    } else if (event._tag === "ShellCompleted") {
      if (loop.model.currentThreadId !== event.threadId) return
      if (event.incognito) loop.model = update(loop.model, { _tag: "AssistantCompleted", text: event.text })
      loop.model = update(loop.model, { _tag: "ExecutionCompleted" })
    } else if (event._tag === "TitleCostUpdated") {
      if (loop.model.currentThreadId === event.threadId) {
        loop.threadCostUsd = event.threadCostUsd
        loop.model = { ...loop.model, costUsd: event.threadCostUsd }
      }
    } else if (event._tag === "ThreadTitled") {
      loop.model = update(loop.model, {
        _tag: "ThreadTitleChanged",
        threadId: event.threadId,
        title: event.title,
      })
      if (loop.model.currentThreadId === event.threadId) refreshTerminalTitle()
    } else if (event._tag === "ThreadActivated") {
      loop.model = update(loop.model, {
        _tag: "ThreadActivated",
        threadId: event.threadId,
        title: event.title,
      })
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
    } else {
      loop.model = update(loop.model, event)
    }
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
      loop.feedTimer = fork(
        Effect.sleep("16 millis").pipe(
          Effect.andThen(
            Effect.sync(() => {
              loop.feedTimer = undefined
              flush()
            }),
          ),
        ),
      )
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
