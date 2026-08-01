#!/usr/bin/env bun
import * as ProductOperation from "@rika/product/product-operation"
import * as InteractiveEvent from "@rika/product/interactive-event"
import * as InteractiveSession from "@rika/product/interactive-session"
import * as TranscriptPage from "@rika/product/transcript-page"
import * as BunServices from "@effect/platform-bun/BunServices"
import * as InteractiveFeed from "@rika/product/resident-interactive-feed"
import * as Thread from "@rika/product/thread-record"
import * as Turn from "@rika/product/turn-record"
import * as TranscriptProjection from "@rika/transcript/transcript-projection"
import * as TranscriptProjectionModel from "@rika/transcript/transcript-projection-model"
import * as TranscriptUnit from "@rika/transcript/transcript-unit"
import { create as createTui } from "@rika/terminal/opentui-surface"
import { Mode, Model, initial, withModeRouteMap } from "@rika/terminal/terminal-state"
import type { ThreadItem } from "@rika/terminal/terminal-message"
import { selectedThreadMetadata } from "@rika/terminal/terminal-state-reducer"
type ModeRoutes = Model["modeRoutes"]
type PromptPart = ReturnType<ReturnType<typeof promptParts>>[number]
const nextMode = (mode: Mode): Mode => {
  const modes = Mode.literals
  return modes[(modes.indexOf(mode) + 1) % modes.length]!
}
const nextUsageDisplay = (display: "cost" | "tokens" | "time" | undefined): "cost" | "tokens" | "time" => {
  if (display === "cost") return "tokens"
  if (display === "tokens") return "time"
  return "cost"
}
import { classifyPrompt, displayInput, promptParts } from "@rika/terminal/terminal-session"

import { expandPastedText } from "@rika/terminal/terminal-session"
import { canSubmit, update } from "@rika/terminal/terminal-state-reducer"
import { execute, type Action, type Adapter, type ModelTuning } from "@rika/terminal/terminal-session"
import type { PathTarget } from "@rika/terminal/terminal-transcript-presentation"
import { Cause, Clock, Effect, Fiber, FileSystem, Schema } from "effect"
import { renderGoodbye } from "../input/goodbye-message"
import * as InteractiveController from "../controller/interactive-controller"
import * as ThreadSelection from "../controller/terminal-thread-selection"
import { makeFeedFrameBatcher } from "../controller/interactive-frame-batch"
import * as Process from "./interactive-process"
import * as ProcessLayer from "./process-layer"
import { imagePasteBlockedNotice } from "../input/prompt-input"
import { initialSubmitAction } from "../input/command-input"
import { nextSubmissionId } from "../controller/terminal-turn-submission"
import * as Logging from "../../logging"
import { workspaceDirectory } from "@rika/configuration/configuration-paths"

export interface InteractiveTuiOptions {
  readonly editor?: string | undefined
  readonly modeRoutes?: (() => ModeRoutes | undefined) | undefined
  readonly makeRenderer?: NonNullable<Parameters<typeof createTui>[0]["makeRenderer"]>
  readonly writeTerminalTitle?: (sequence: string) => void
}

const terminalTitleSequence = Process.terminalTitleSequence
const ignoreSelectionResync = Process.ignoreSelectionResync
const traceTuiModelEvent = Process.traceTuiModelEvent
const provideLayerScoped = ProcessLayer.provideLayerScoped
const mkdir = Process.mkdir
const rm = Process.rm
const childExit = Process.childExit
const workspaceGlob = Process.workspaceGlob
const resolveLocalFileImpl = Process.resolveLocalFileImpl
const gitOutput = Process.gitOutput
const readChangedFilesEffect = Process.readChangedFilesEffect
const quitStopWorkBound = Process.quitStopWorkBound
const failureKind = Process.failureKind
const materializePromptParts = Process.materializePromptParts
const refreshChangedFilesOn = Process.refreshChangedFilesOn
const pastedImagePath = Process.pastedImagePath
const persistPastedImage = Process.persistPastedImage
const pasteClipboardPng = Process.pasteClipboardPng
const defaultOpenArguments = Process.defaultOpenArguments
const editorArguments = Process.editorArguments
const interruptTrackedFibers = Process.interruptTrackedFibers
const tuiSignalExitCode = Process.tuiSignalExitCode
const settleTuiInitialization = Process.settleTuiInitialization

export const interactiveTui =
  (options: InteractiveTuiOptions) =>
  (
    input: InteractiveFeed.InteractiveInput,
    session: InteractiveSession.InteractiveSession,
  ): Effect.Effect<void, ProductOperation.OperationUnavailable> =>
    Effect.uninterruptible(
      Effect.gen(function* () {
        if (options.makeRenderer === undefined && (!process.stdin.isTTY || !process.stdout.isTTY)) return
        const context = yield* Effect.context<never>()
        const fork = Effect.runForkWith(context)
        const resolvedModeRoutes = options.modeRoutes?.()
        return yield* Effect.callback<void, ProductOperation.OperationUnavailable>((resume) => {
          let model = initial(input.workspace ?? process.cwd(), input.mode ?? "medium")
          if (resolvedModeRoutes !== undefined) model = withModeRouteMap(model, resolvedModeRoutes)
          let workingFrame: string | undefined
          const writeTerminalTitle =
            options.writeTerminalTitle ?? ((sequence: string) => process.stdout.write(sequence))
          const refreshTerminalTitle = () => {
            const threadId = model.currentThreadId
            const title =
              model.currentThreadTitle ??
              (model.threads as ReadonlyArray<ThreadItem>).find((thread) => thread.id === threadId)?.title
            if (title !== undefined)
              writeTerminalTitle(terminalTitleSequence(title, model.workspace, model.busy ? workingFrame : undefined))
          }
          let renderer: Effect.Success<ReturnType<typeof createTui>> | undefined
          let initialization: Fiber.Fiber<void, never> | undefined
          let closed = false
          const recoverSession = <R>(
            effect: Effect.Effect<void, ProductOperation.OperationUnavailable, R>,
          ): Effect.Effect<void, never, R> =>
            effect.pipe(
              Effect.catchTag("OperationUnavailable", (error) =>
                closed ? Effect.void : Effect.logError(error.message),
              ),
            )
          let previewTimer: Fiber.Fiber<void, never> | undefined
          let renderTimer: Fiber.Fiber<void, never> | undefined
          let feedTimer: Fiber.Fiber<void, never> | undefined
          let applyingFeedBatch = false
          let feedPreserveAnchor = false
          let replayTurns = new Map<string, Turn.Turn>()
          let loadedTranscriptEntries: ReadonlyArray<TranscriptPage.Entry> = []
          let projectionRevisions = new Map<string, number>()
          let liveTranscriptProjections = new Map<string, TranscriptProjectionModel.Projection>()
          let projectionStreams = new Map<string, InteractiveController.ProjectionStream>()
          let threadCostUsd: number | undefined
          let lastAvailableUsageCost: Extract<Model["usageCost"], { readonly _tag: "Available" }> | undefined
          let transcriptHasOlder = false
          let transcriptHasNewer = false
          let transcriptOldestCursor: TranscriptPage.PageCursor | undefined
          let transcriptNewestCursor: TranscriptPage.PageCursor | undefined
          const appliedDeltas = new Set<string>()
          let activeSelectionEpoch = 0
          let submissionSequence = 0
          const fibers = new Set<Fiber.Fiber<void, never>>()
          let selectionFiber: Fiber.Fiber<void, never> | undefined
          let selectionGeneration = 0
          let renderSuppressed = false
          let loadingOlder = false
          let pendingNewer:
            | { readonly threadId: string; readonly selectionEpoch: number; readonly cursor: string }
            | undefined
          const selectionResyncs = new Set<string>()
          let requestSelectionResync = ignoreSelectionResync
          const queueResyncs = new Set<string>()
          const requestQueueResync = (threadId: Thread.ThreadId) => {
            const key = String(threadId)
            if (queueResyncs.has(key)) return
            queueResyncs.add(key)
            fork(session.readQueue(threadId).pipe(Effect.ensuring(Effect.sync(() => queueResyncs.delete(key)))))
          }
          const render = (immediate = false) => {
            if (applyingFeedBatch) return
            if (renderer === undefined || renderSuppressed) return
            if (immediate) {
              if (renderTimer !== undefined) fork(Fiber.interrupt(renderTimer))
              renderTimer = undefined
              renderer.surface.update(model)
              return
            }
            if (renderTimer !== undefined) return
            renderTimer = fork(
              Effect.sleep("16 millis").pipe(
                Effect.andThen(
                  Effect.sync(() => {
                    renderTimer = undefined
                    renderer?.surface.update(model)
                  }),
                ),
              ),
            )
          }
          const dispatch = (event: InteractiveEvent.InteractiveEvent) => {
            if (closed) return
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
              const previousThreadId = model.currentThreadId
              const previousThreadTitle = model.currentThreadTitle
              const controlled = InteractiveController.update(
                {
                  model,
                  selectionEpoch: activeSelectionEpoch,
                  replayTurns,
                  entries: loadedTranscriptEntries,
                  revisions: projectionRevisions,
                  liveProjections: liveTranscriptProjections,
                  projectionStreams,
                  ...(threadCostUsd === undefined ? {} : { threadCostUsd }),
                  ...(lastAvailableUsageCost === undefined ? {} : { lastAvailableUsageCost }),
                  hasOlder: transcriptHasOlder,
                  hasNewer: transcriptHasNewer,
                  ...(transcriptOldestCursor === undefined ? {} : { oldestCursor: transcriptOldestCursor }),
                  ...(transcriptNewestCursor === undefined ? {} : { newestCursor: transcriptNewestCursor }),
                },
                event,
              )
              model = controlled.state.model
              activeSelectionEpoch = controlled.state.selectionEpoch
              replayTurns = new Map(controlled.state.replayTurns)
              loadedTranscriptEntries = controlled.state.entries
              projectionRevisions = new Map(controlled.state.revisions)
              liveTranscriptProjections = new Map(controlled.state.liveProjections)
              projectionStreams = new Map(controlled.state.projectionStreams)
              threadCostUsd = controlled.state.threadCostUsd
              lastAvailableUsageCost = controlled.state.lastAvailableUsageCost
              transcriptHasOlder = controlled.state.hasOlder ?? false
              transcriptHasNewer = controlled.state.hasNewer ?? false
              transcriptOldestCursor = controlled.state.oldestCursor
              transcriptNewestCursor = controlled.state.newestCursor
              if (event._tag === "SelectionLoaded") {
                loadingOlder = false
                pendingNewer = undefined
              } else if (
                event._tag === "TranscriptPageAppended" &&
                pendingNewer?.threadId === event.threadId &&
                pendingNewer.selectionEpoch === event.selectionEpoch &&
                pendingNewer.cursor === JSON.stringify(event.requestedAfter)
              )
                pendingNewer = undefined
              if (
                event._tag === "SelectionLoaded" &&
                model.currentThreadId === event.thread.id &&
                (model.currentThreadId !== previousThreadId || model.currentThreadTitle !== previousThreadTitle)
              )
                refreshTerminalTitle()
              if (event._tag === "TranscriptProjectionPatched") fork(traceTuiModelEvent(appliedDeltas, event))
              if (
                (event._tag === "TranscriptResyncRequired" || controlled.resync === true) &&
                model.currentThreadId !== undefined
              )
                requestSelectionResync(model.currentThreadId, event.selectionEpoch)
              if (controlled.preserveAnchor) {
                if (applyingFeedBatch) feedPreserveAnchor = true
                else renderer?.surface.update(model, true)
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
              return
            }
            if (event._tag === "QueueUpdated") {
              if (
                event.selectionEpoch === activeSelectionEpoch &&
                (model.currentThreadId === undefined || model.currentThreadId === event.threadId)
              ) {
                const updated = ThreadSelection.updateQueue(model, event)
                model = updated.model
                if (updated.resync) requestQueueResync(event.threadId)
              }
            } else if (event._tag === "QueueResyncRequired") {
              if (
                event.selectionEpoch === activeSelectionEpoch &&
                (model.currentThreadId === undefined || model.currentThreadId === event.threadId)
              )
                requestQueueResync(event.threadId)
            } else if (event._tag === "TurnStarted") {
              if (
                event.selectionEpoch === activeSelectionEpoch &&
                (model.currentThreadId === undefined || model.currentThreadId === event.threadId)
              ) {
                const known = replayTurns.get(event.turn.id)
                if (
                  known?.status === "completed" ||
                  known?.status === "failed" ||
                  known?.status === "cancelled" ||
                  model.activeTurnId === event.turn.id
                )
                  return
                if (model.queue.some((item) => item.id === event.turn.id)) {
                  model = ThreadSelection.removePromotedTurn(model, event.threadId, event.turn.id)
                  fork(session.readQueue(event.threadId))
                }
                replayTurns.set(event.turn.id, event.turn)
                const seed = TranscriptProjection.Projection.empty(event.turn.id, event.turn.prompt)
                loadedTranscriptEntries = [
                  ...loadedTranscriptEntries,
                  ...seed.units.map((unit) => ({
                    turn: event.turn,
                    unit,
                    projectionRevision: seed.revision,
                    projectionModelPhase: seed.modelPhase,
                  })),
                ]
                model = update(model, {
                  _tag: "TurnStarted",
                  turnId: event.turn.id,
                  prompt: event.turn.prompt,
                  ...(event.submissionId === undefined ? {} : { submissionId: event.submissionId }),
                })
              }
            } else if (event._tag === "SubmissionAdmitted") {
              if (
                event.selectionEpoch === activeSelectionEpoch &&
                (model.currentThreadId === undefined || model.currentThreadId === event.threadId)
              )
                model = update(model, {
                  _tag: "SubmissionAdmitted",
                  turnId: event.turnId,
                  status: event.status,
                  ...(event.submissionId === undefined ? {} : { submissionId: event.submissionId }),
                })
            } else if (event._tag === "ThreadsListed") {
              model = update(model, {
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
              if (event.threadId !== undefined && event.selectionEpoch !== activeSelectionEpoch) return
              if (event.threadId !== undefined && model.currentThreadId !== event.threadId) return
              if (event.action === "cancelled")
                model = update(model, {
                  _tag: "ExecutionCancelled",
                  ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
                  ...(event.agentResponseArrived === undefined
                    ? {}
                    : { agentResponseArrived: event.agentResponseArrived }),
                })
              if (
                event.action === "steered" &&
                event.turnId !== undefined &&
                event.steeringSequence !== undefined &&
                event.steeringText !== undefined
              )
                model = update(model, {
                  _tag: "SteeringAccepted",
                  turnId: event.turnId,
                  sequence: event.steeringSequence,
                  text: event.steeringText,
                })
            } else if (event._tag === "ExecutionControlFailed") {
              if (event.threadId !== undefined && event.selectionEpoch !== activeSelectionEpoch) return
              if (event.threadId !== undefined && model.currentThreadId !== event.threadId) return
              if (event.action === "steer" && event.turnId !== undefined && event.steeringText !== undefined)
                model = update(model, {
                  _tag: "SteeringFailed",
                  turnId: event.turnId,
                  text: event.steeringText,
                  message: event.message,
                })
              if (event.action === "cancel")
                model = update(model, {
                  _tag: "CancelFailed",
                  ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
                  message: event.message,
                })
            } else if (event._tag === "ContextDiagnostics") {
              if (event.selectionEpoch !== activeSelectionEpoch) return
              if (model.currentThreadId !== event.threadId) return
              model = update(model, {
                _tag: "BlockAdded",
                block: {
                  _tag: "Notification",
                  title: "Context resolution",
                  detail: event.messages.join("\n"),
                },
              })
            } else if (event._tag === "ExecutionFailed") {
              if (event.threadId !== undefined && event.selectionEpoch !== activeSelectionEpoch) return
              if (event.threadId !== undefined && model.currentThreadId !== event.threadId) return
              model = update(model, {
                _tag: "ExecutionFailed",
                ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
                message: event.message,
              })
            } else if (event._tag === "QueueFull") {
              if (event.selectionEpoch !== activeSelectionEpoch) return
              if (model.currentThreadId !== undefined && model.currentThreadId !== event.threadId) return
              model = ThreadSelection.updateQueue(model, event).model
            } else if (event._tag === "ShellCompleted") {
              if (model.currentThreadId !== event.threadId) return
              if (event.incognito) model = update(model, { _tag: "AssistantCompleted", text: event.text })
              model = update(model, { _tag: "ExecutionCompleted" })
            } else if (event._tag === "TitleCostUpdated") {
              if (model.currentThreadId === event.threadId) {
                threadCostUsd = event.threadCostUsd
                model = { ...model, costUsd: event.threadCostUsd }
              }
            } else if (event._tag === "ThreadTitled") {
              model = update(model, {
                _tag: "ThreadTitleChanged",
                threadId: event.threadId,
                title: event.title,
              })
              if (model.currentThreadId === event.threadId) refreshTerminalTitle()
            } else if (event._tag === "ThreadActivated") {
              model = update(model, {
                _tag: "ThreadActivated",
                threadId: event.threadId,
                title: event.title,
              })
              if (model.currentThreadId === event.threadId) refreshTerminalTitle()
            } else if (event._tag === "ThreadPreviewLoaded") {
              if (model.threadSwitcher.open && selectedThreadMetadata(model)?.id === event.threadId)
                model = update(model, {
                  _tag: "ThreadPreviewLoaded",
                  threadId: event.threadId,
                  turns: event.turns.map((turn) => ({
                    prompt: turn.prompt,
                    units: turn.units.map((unit) => Schema.decodeUnknownSync(TranscriptUnit.Unit)(unit)),
                  })),
                })
            } else {
              model = update(model, event)
            }
            render(
              event._tag === "ContextDiagnostics" ||
                event._tag === "ExecutionFailed" ||
                event._tag === "QueueFull" ||
                event._tag === "ExecutionControlled",
            )
          }
          const feedBatcher = makeFeedFrameBatcher<InteractiveEvent.InteractiveEvent>({
            schedule: (flush) => {
              feedTimer = fork(
                Effect.sleep("16 millis").pipe(
                  Effect.andThen(
                    Effect.sync(() => {
                      feedTimer = undefined
                      flush()
                    }),
                  ),
                ),
              )
            },
            apply: (events) => {
              applyingFeedBatch = true
              try {
                for (const event of events) dispatch(event)
              } finally {
                applyingFeedBatch = false
              }
            },
            render: () => {
              if (renderer !== undefined && !renderSuppressed) renderer.surface.update(model, feedPreserveAnchor)
              feedPreserveAnchor = false
            },
          })
          let closing = false
          let interruptCancellationRequested = false
          let submittedSinceIdle = false
          let teardownStarted = false
          let terminalPauseCount = 0
          let pendingJobControlPause = false
          let releaseJobControlPause: (() => boolean) | undefined
          const pauseTerminal = () => {
            if (closed) return () => false
            if (terminalPauseCount === 0)
              try {
                renderer?.suspendTerminal()
              } catch (cause) {
                close(1)
                throw cause
              }
            terminalPauseCount += 1
            let released = false
            return () => {
              if (released) return false
              released = true
              terminalPauseCount = Math.max(0, terminalPauseCount - 1)
              if (closed || terminalPauseCount > 0) return false
              try {
                renderer?.resumeTerminal()
              } catch (cause) {
                close(1)
                throw cause
              }
              return true
            }
          }
          const goodbye = () => {
            const threadId = model.currentThreadId
            const threadTitle =
              model.currentThreadTitle ??
              (model.threads as ReadonlyArray<ThreadItem>).find((thread) => thread.id === threadId)?.title
            try {
              process.stdout.write(
                renderGoodbye({
                  mode: model.mode,
                  workspace: model.workspace,
                  ...(threadId === undefined ? {} : { threadId }),
                  ...(threadTitle === undefined ? {} : { threadTitle }),
                }),
              )
            } catch {
              return
            }
          }
          const teardown = (showGoodbye: boolean) =>
            Effect.suspend(() => {
              if (teardownStarted) return Effect.void
              teardownStarted = true
              return Effect.gen(function* () {
                yield* Effect.logInfo("tui.teardown.started")
                closed = true
                process.off("SIGINT", interrupt)
                process.off("SIGTERM", terminate)
                process.off("SIGHUP", hangup)
                process.off("SIGTSTP", suspend)
                process.off("SIGCONT", continueFromSuspend)
                process.stdin.off("end", hangup)
                process.stdin.off("error", hangup)
                process.stdin.off("close", hangup)
                if (previewTimer !== undefined) yield* Fiber.interrupt(previewTimer)
                previewTimer = undefined
                if (renderTimer !== undefined) yield* Fiber.interrupt(renderTimer)
                renderTimer = undefined
                if (feedTimer !== undefined) yield* Fiber.interrupt(feedTimer)
                feedTimer = undefined
                Logging.settleActiveLogs()
                renderer?.releaseTerminal()
                if (initialization !== undefined) yield* Fiber.await(initialization)
                yield* interruptTrackedFibers([...fibers])
                if (showGoodbye) goodbye()
                yield* Effect.logInfo("tui.teardown.completed")
              })
            })
          const close = (exitCode?: number, showGoodbye = true) => {
            if (closing) return
            closing = true
            if (exitCode !== undefined) process.exitCode = exitCode
            fork(
              session.quit.pipe(
                Effect.timeoutOrElse({
                  duration: quitStopWorkBound,
                  orElse: () => Effect.logWarning("tui.quit.stop_work.timeout"),
                }),
                Effect.catch((failure) =>
                  Effect.logWarning("tui.quit.stop_work.failed").pipe(
                    Effect.annotateLogs("rika.failure.kind", failure instanceof Error ? failure.name : "unknown"),
                  ),
                ),
                Effect.andThen(teardown(showGoodbye)),
                Effect.andThen(Effect.sync(() => resume(Effect.void))),
              ),
            )
          }
          const interrupt = () => {
            if (
              !interruptCancellationRequested &&
              (submittedSinceIdle || model.busy || model.activeTurnId !== undefined || model.activity !== undefined)
            ) {
              interruptCancellationRequested = true
              run(session.cancel)
              return
            }
            close(tuiSignalExitCode("SIGINT"))
          }
          const terminate = () => close(tuiSignalExitCode("SIGTERM"))
          const hangup = () => close(tuiSignalExitCode("SIGHUP"), false)
          const suspend = () => {
            if (closed || pendingJobControlPause || releaseJobControlPause !== undefined) return
            if (renderer === undefined) {
              pendingJobControlPause = true
              return
            }
            try {
              releaseJobControlPause = pauseTerminal()
              process.kill(process.pid, "SIGSTOP")
            } catch {
              releaseJobControlPause?.()
              releaseJobControlPause = undefined
              close(1)
            }
          }
          const continueFromSuspend = () => {
            if (pendingJobControlPause) {
              pendingJobControlPause = false
              return
            }
            if (closed || releaseJobControlPause === undefined) return
            const release = releaseJobControlPause
            releaseJobControlPause = undefined
            try {
              if (release()) renderer?.surface.update(model)
            } catch {
              close(1)
            }
          }
          process.on("SIGINT", interrupt)
          process.once("SIGTERM", terminate)
          process.on("SIGHUP", hangup)
          process.stdin.once("end", hangup)
          process.stdin.once("error", hangup)
          process.stdin.once("close", hangup)
          process.on("SIGTSTP", suspend)
          process.on("SIGCONT", continueFromSuspend)
          const submit = (
            prompt: string,
            parts: ReadonlyArray<PromptPart>,
            mode: Mode,
            tuning?: ModelTuning,
            submissionId?: string,
          ) => {
            const classified = classifyPrompt(prompt)
            const effect =
              classified._tag === "Shell"
                ? session.shell(
                    model.currentThreadId === undefined ? undefined : Thread.ThreadId.make(model.currentThreadId),
                    classified.command,
                    classified.incognito,
                  )
                : materializePromptParts(parts, model.workspace).pipe(
                    Effect.flatMap((materialized) =>
                      session.submit(classified.prompt, mode, materialized, tuning, submissionId),
                    ),
                    Effect.catchTag("PromptAttachmentError", (failure) =>
                      Effect.sync(() => {
                        let restored: Model = {
                          ...model,
                          input: "",
                          cursor: 0,
                          pastedText: [],
                          busy: false,
                          activity: undefined,
                        }
                        for (const [index, part] of parts.entries()) {
                          if (part.type === "image") {
                            if (index !== failure.index)
                              restored = update(restored, { _tag: "ImageInserted", path: part.path })
                          } else {
                            restored = {
                              ...restored,
                              input:
                                restored.input.slice(0, restored.cursor) +
                                part.text +
                                restored.input.slice(restored.cursor),
                              cursor: restored.cursor + part.text.length,
                            }
                          }
                        }
                        model = update(restored, { _tag: "ExecutionFailed", message: failure.message })
                        renderer?.surface.update(model)
                      }),
                    ),
                  )
            const fiber = effect.pipe(provideLayerScoped(BunServices.layer), recoverSession, fork)
            fibers.add(fiber)
            fork(Fiber.await(fiber).pipe(Effect.tap(() => Effect.sync(() => fibers.delete(fiber)))))
          }
          const run = <E>(effect: Effect.Effect<void, E, BunServices.BunServices>) => {
            const fiber = fork(
              effect.pipe(
                provideLayerScoped(BunServices.layer),
                Effect.catchCause((cause) => Effect.logError(Cause.pretty(cause))),
              ),
            )
            fibers.add(fiber)
            fork(Fiber.await(fiber).pipe(Effect.tap(() => Effect.sync(() => fibers.delete(fiber)))))
          }
          const requestNewerPage = () => {
            const threadId = model.currentThreadId
            if (
              !transcriptHasNewer ||
              pendingNewer !== undefined ||
              transcriptNewestCursor === undefined ||
              threadId === undefined
            )
              return
            const cursor = transcriptNewestCursor
            pendingNewer = { threadId, selectionEpoch: activeSelectionEpoch, cursor: JSON.stringify(cursor) }
            run(
              session.loadNewer(threadId, activeSelectionEpoch, cursor).pipe(
                Effect.tapError(() =>
                  Effect.sync(() => {
                    pendingNewer = undefined
                  }),
                ),
              ),
            )
          }
          const loadSelected = (
            effect: Effect.Effect<void, ProductOperation.OperationUnavailable>,
            generation: number,
          ) =>
            Effect.gen(function* () {
              yield* Effect.sync(() => {
                if (generation !== selectionGeneration) return
                model = update(model, { _tag: "ThreadOpenRequested" })
                renderer?.surface.update(model)
                renderSuppressed = true
              })
              yield* effect.pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    if (generation !== selectionGeneration) return
                    renderSuppressed = false
                    model = update(model, { _tag: "ThreadOpenCompleted" })
                    renderer?.surface.update(model)
                  }),
                ),
              )
            })
          const startSelection = (
            select: (epoch: number) => Effect.Effect<void, ProductOperation.OperationUnavailable>,
          ) => {
            const generation = (selectionGeneration += 1)
            const previous = selectionFiber
            let selectedFiber: Fiber.Fiber<void, never>
            selectedFiber = fork(
              (previous === undefined ? Effect.void : Fiber.interrupt(previous)).pipe(
                Effect.andThen(recoverSession(loadSelected(select(generation), generation))),
                Effect.ensuring(
                  Effect.sync(() => {
                    fibers.delete(selectedFiber)
                    if (selectionFiber === selectedFiber) selectionFiber = undefined
                  }),
                ),
              ),
            )
            selectionFiber = selectedFiber
            fibers.add(selectedFiber)
            return selectedFiber
          }
          requestSelectionResync = (threadId, selectionEpoch) => {
            if (selectionEpoch !== activeSelectionEpoch || model.currentThreadId !== threadId) return
            const key = `${threadId}:${selectionEpoch}`
            if (selectionResyncs.has(key)) return
            selectionResyncs.add(key)
            startSelection((epoch) =>
              session
                .selectThread(threadId, epoch)
                .pipe(Effect.ensuring(Effect.sync(() => selectionResyncs.delete(key)))),
            )
          }
          const loadChangedFiles = () =>
            readChangedFilesEffect(model.workspace).pipe(
              Effect.tap((files) =>
                Effect.sync(() => {
                  const current = model
                  model = update(current, { _tag: "ChangedFilesReplaced", files })
                  if (model !== current) renderer?.surface.update(model)
                }),
              ),
              Effect.asVoid,
            )
          const watchChangedFiles = FileSystem.FileSystem.pipe(
            Effect.flatMap((fileSystem) =>
              refreshChangedFilesOn(
                fileSystem.watch(model.workspace),
                () => model.changedFilesOpen,
                loadChangedFiles(),
              ),
            ),
            Effect.catchCause((cause) => Effect.logWarning(`changed-files watcher stopped: ${Cause.pretty(cause)}`)),
          )
          const editComposer = () =>
            Clock.currentTimeMillis.pipe(
              Effect.flatMap((now) =>
                Effect.gen(function* () {
                  const fileSystem = yield* FileSystem.FileSystem
                  if (options.editor === undefined) {
                    renderer?.surface.showToast("Set VISUAL or EDITOR to edit the prompt", "#e06c75")
                    return
                  }
                  const relative = `${workspaceDirectory}/compose-${now}.md`
                  const file = `${model.workspace}/${relative}`
                  yield* mkdir(`${model.workspace}/.rika`, { recursive: true })
                  yield* fileSystem.writeFileString(file, displayInput(model))
                  const resumeTerminal = pauseTerminal()
                  yield* childExit("run editor", [options.editor, file], {
                    stdin: "inherit",
                    stdout: "inherit",
                    stderr: "inherit",
                    detached: false,
                  }).pipe(Effect.ensuring(Effect.sync(resumeTerminal)))
                  const edited = yield* fileSystem.readFileString(file)
                  yield* rm(file, { force: true })
                  model = update(model, { _tag: "ComposerReplaced", text: edited.replace(/\n$/, "") })
                  renderer?.surface.update(model)
                }),
              ),
              Effect.asVoid,
            )
          let openingPath = false
          const openPath = (target: PathTarget) => {
            if (openingPath) return
            openingPath = true
            run(
              resolveLocalFileImpl(model.workspace, target).pipe(
                Effect.matchEffect({
                  onFailure: (failure) =>
                    Effect.sync(() => {
                      renderer?.surface.showToast(failure.message, "#e06c75")
                    }),
                  onSuccess: (path) =>
                    Effect.gen(function* () {
                      if (options.editor === undefined) {
                        const exit = yield* childExit("open file", defaultOpenArguments(path), {
                          stdin: "ignore",
                          stdout: "ignore",
                          stderr: "ignore",
                        }).pipe(Effect.orElseSucceed(() => -1))
                        if (exit === 0) return
                        renderer?.surface.showToast("Could not open the file in the default application", "#e06c75")
                        return
                      }
                      const resumeTerminal = pauseTerminal()
                      const exit = yield* childExit(
                        "open editor",
                        editorArguments(options.editor, path, target.line, target.column),
                        {
                          stdin: "inherit",
                          stdout: "inherit",
                          stderr: "inherit",
                          detached: false,
                        },
                      ).pipe(
                        Effect.orElseSucceed(() => -1),
                        Effect.ensuring(
                          Effect.sync(() => {
                            if (resumeTerminal() && !closed) renderer?.surface.update(model)
                          }),
                        ),
                      )
                      if (exit !== 0)
                        renderer?.surface.showToast("Could not open the file in the configured editor", "#e06c75")
                    }),
                }),
                Effect.asVoid,
                Effect.ensuring(
                  Effect.sync(() => {
                    openingPath = false
                  }),
                ),
              ),
            )
          }
          const adapter: Adapter = {
            submit,
            quit: () => close(),
            editQueued: (id, prompt) => run(session.editQueued(id, prompt)),
            dequeue: (id) => run(session.dequeue(id)),
            steerQueued: (id, prompt) => run(session.steerQueued(id, prompt)),
            steer: (prompt, turnId) => run(session.steer(prompt, turnId)),
            interruptAndSend: (prompt) => run(session.interruptAndSend(prompt)),
            cancel: () => run(session.cancel),
            selectThread: (id) => {
              startSelection((epoch) => session.selectThread(id, epoch))
            },
          }
          const consumePendingAction = () => {
            const action = model.pendingAction as Action | undefined
            const paletteCommand = InteractiveController.paletteCommand(action)
            if (paletteCommand?._tag === "NewThread") startSelection(() => session.newThread)
            else if (action !== undefined) {
              execute(adapter, action)
            }
            model = update(model, { _tag: "PaletteActionConsumed" })
          }
          initialization = fork(
            settleTuiInitialization(
              createTui({
                ...(options.makeRenderer === undefined ? {} : { makeRenderer: options.makeRenderer }),
                workingFrame: (frame) => {
                  if (workingFrame === frame) return
                  workingFrame = frame
                  refreshTerminalTitle()
                },
                openPath,
                scroll: (offset) => {
                  model = update(model, { _tag: "ScrollMoved", offset })
                  if (offset <= 0 && !loadingOlder) {
                    const threadId = model.currentThreadId
                    const before = transcriptOldestCursor
                    if (!transcriptHasOlder || threadId === undefined || before === undefined) return
                    loadingOlder = true
                    run(
                      session
                        .loadOlder(
                          threadId,
                          activeSelectionEpoch,
                          before,
                          loadedTranscriptEntries.map((entry) => entry.unit.key),
                        )
                        .pipe(
                          Effect.ensuring(
                            Effect.sync(() => {
                              loadingOlder = false
                            }),
                          ),
                        ),
                    )
                  }
                  if (offset > 0 && !loadingOlder) requestNewerPage()
                },
                scrollGeometry: (offset) => {
                  model = update(model, { _tag: "ScrollMoved", offset })
                },
                scrollFollow: () => {
                  model = update(model, { _tag: "ScrollFollowed" })
                  requestNewerPage()
                },
                paste: (text) => {
                  model = update(model, { _tag: "Pasted", text })
                  renderer?.surface.update(model)
                },
                expandPaste: (token) => {
                  model = update(model, { _tag: "PastedTextExpanded", token })
                  renderer?.surface.update(model)
                },
                pasteImage: (image) => {
                  const blocked = imagePasteBlockedNotice(model)
                  if (blocked !== undefined) {
                    renderer?.surface.showToast(blocked)
                    return
                  }
                  if (image !== undefined) {
                    const path = pastedImagePath(image.bytes, image.mediaType)
                    if (path === undefined) {
                      renderer?.surface.showToast("Pasted image must be a non-empty PNG, JPEG, GIF, or WebP")
                      return
                    }
                    model = update(model, { _tag: "ImageInserted", path })
                    renderer?.surface.update(model)
                    run(
                      persistPastedImage(model.workspace, path, image.bytes).pipe(
                        Effect.tap((persisted) =>
                          Effect.sync(() => {
                            if (persisted) return
                            model = update(model, { _tag: "ImageRemoved", path })
                            renderer?.surface.update(model)
                            renderer?.surface.showToast("Pasted image could not be saved")
                          }),
                        ),
                        Effect.asVoid,
                      ),
                    )
                    return
                  }
                  run(
                    pasteClipboardPng(model.workspace).pipe(
                      Effect.tap((path) =>
                        Effect.sync(() => {
                          if (path === undefined) {
                            renderer?.surface.showToast("Clipboard does not contain a supported non-empty PNG image")
                            return
                          }
                          model = update(model, { _tag: "ImageInserted", path })
                          renderer?.surface.update(model)
                        }),
                      ),
                      Effect.asVoid,
                    ),
                  )
                },
                clickToggle: (unit) => {
                  model = update(model, { _tag: "DetailToggled", id: unit })
                  renderer?.surface.update(model)
                },
                usageToggle: () => {
                  model = {
                    ...model,
                    usageDisplay: nextUsageDisplay(model.usageDisplay),
                  }
                  render()
                },
                modeToggle: () => {
                  if (model.busy) return
                  model = { ...model, mode: nextMode(model.mode) }
                  render()
                },
                key: (key) => {
                  if (key.ctrl && key.name === "c" && !model.busy) {
                    close()
                    return
                  }
                  if (key.ctrl && key.name === "g") {
                    run(editComposer())
                    return
                  }
                  const wasChangedFilesOpen = model.changedFilesOpen
                  const beforePreviewId = model.threadSwitcher.open ? selectedThreadMetadata(model)?.id : undefined
                  const submitting = key.name === "return" && !key.shift && !key.ctrl && canSubmit(model)
                  const submission = submitting ? nextSubmissionId(submissionSequence) : undefined
                  if (submission !== undefined) submissionSequence = submission.sequence
                  const submissionId = submission?.id
                  const prompt = submitting ? model.input : undefined
                  const parts = prompt === undefined ? undefined : promptParts(prompt, model.pastedText)
                  const submittedPrompt = prompt === undefined ? undefined : expandPastedText(prompt, model.pastedText)
                  model = update(model, { _tag: "KeyPressed", key })
                  if (submitting)
                    model = update(model, {
                      _tag: "Submitted",
                      ...(submissionId === undefined ? {} : { submissionId }),
                    })
                  if (!wasChangedFilesOpen && model.changedFilesOpen)
                    model = update(model, { _tag: "ChangedFilesRequested" })
                  const afterPreviewId = model.threadSwitcher.open ? selectedThreadMetadata(model)?.id : undefined
                  if (afterPreviewId !== undefined && afterPreviewId !== beforePreviewId)
                    model = update(model, { _tag: "ThreadPreviewRequested" })
                  renderer?.surface.update(model)
                  if (!wasChangedFilesOpen && model.changedFilesOpen) run(loadChangedFiles())
                  if (afterPreviewId !== undefined && afterPreviewId !== beforePreviewId) {
                    if (previewTimer !== undefined) fork(Fiber.interrupt(previewTimer))
                    const selectedPreviewTimer = Effect.sleep("120 millis").pipe(
                      Effect.andThen(session.previewThread(afterPreviewId)),
                      Effect.ensuring(
                        Effect.sync(() => {
                          if (previewTimer === selectedPreviewTimer) previewTimer = undefined
                        }),
                      ),
                      recoverSession,
                      fork,
                    )
                    previewTimer = selectedPreviewTimer
                  }
                  if (submittedPrompt !== undefined && submittedPrompt.length > 0 && parts !== undefined) {
                    submittedSinceIdle = true
                    execute(adapter, {
                      _tag: "Submit",
                      prompt: submittedPrompt,
                      parts,
                      mode: model.mode,
                      tuning: { fastMode: model.fastMode },
                      ...(submissionId === undefined ? {} : { submissionId }),
                    })
                  }
                  if (!model.busy && model.activeTurnId === undefined && model.activity === undefined)
                    submittedSinceIdle = false
                  const action = model.pendingAction as Action | undefined
                  if (action !== undefined) consumePendingAction()
                },
                resize: (width, height) => {
                  model = update(model, { _tag: "Resized", width, height })
                  renderer?.surface.update(model)
                },
                composerResize: (height) => {
                  model = update(model, { _tag: "ComposerHeightChanged", height })
                  renderer?.surface.update(model)
                },
                sidebarResize: (width) => {
                  model = update(model, { _tag: "SidebarWidthChanged", width })
                  renderer?.surface.update(model)
                },
                threadSidebarSelect: (index) => {
                  model = update(model, { _tag: "ThreadSidebarSelectionConfirmed", index })
                  renderer?.surface.update(model)
                  const action = model.pendingAction as Action | undefined
                  if (action !== undefined) consumePendingAction()
                },
                threadPreviewScroll: (offset) => {
                  model = update(model, { _tag: "ThreadPreviewScrolled", offset })
                  renderer?.surface.update(model)
                },
              }),
              () => closed,
              (created) => Effect.sync(() => created.releaseTerminal()),
            ).pipe(
              Effect.tap((created) =>
                Effect.sync(() => {
                  if (created === undefined) return
                  renderer = created
                  if (closed) {
                    created.releaseTerminal()
                    return
                  }
                  if (pendingJobControlPause) {
                    pendingJobControlPause = false
                    suspend()
                  }
                  model = update(model, { _tag: "FilesRequested" })
                  created.surface.update(model)
                  run(Effect.logInfo("tui.renderer.started"))
                  if (closed) return
                  run(session.events(feedBatcher.offer))
                  run(watchChangedFiles)
                  run(
                    workspaceGlob(model.workspace, "**/*", 10_000).pipe(
                      Effect.tap((files) =>
                        Effect.sync(() => {
                          model = update(model, { _tag: "FilesReplaced", files: files.toSorted() })
                          created.surface.update(model)
                        }),
                      ),
                      Effect.catch((error) =>
                        Effect.sync(() => {
                          model = update(model, { _tag: "FilesFailed", message: error.message })
                          created.surface.update(model)
                        }).pipe(Effect.andThen(Effect.logWarning(`workspace file index failed: ${error.message}`))),
                      ),
                      Effect.asVoid,
                    ),
                  )
                  run(
                    gitOutput(["git", "-C", model.workspace, "symbolic-ref", "--short", "HEAD"]).pipe(
                      Effect.tap(([text, exit]) =>
                        Effect.sync(() => {
                          const branch = text.trim()
                          if (exit === 0 && branch.length > 0 && branch !== "HEAD") {
                            model = update(model, { _tag: "BranchDetected", branch })
                            created.surface.update(model)
                          }
                        }),
                      ),
                      Effect.asVoid,
                    ),
                  )
                  const startInitialSelection = () => {
                    if (input.threadId === undefined) return Effect.void
                    return Effect.sync(() =>
                      startSelection((epoch) => session.selectThread(input.threadId!, epoch)),
                    ).pipe(Effect.flatMap(Fiber.join))
                  }
                  run(
                    startInitialSelection().pipe(
                      Effect.andThen(
                        initialSubmitAction(input.prompt, model.mode) === undefined
                          ? Effect.void
                          : Effect.sync(() => {
                              execute(adapter, initialSubmitAction(input.prompt, model.mode)!)
                            }),
                      ),
                    ),
                  )
                }),
              ),
              Effect.catchCause((cause) =>
                Effect.sync(() => {
                  if (closed) return
                  resume(
                    Effect.logError("tui.renderer.failed").pipe(
                      Effect.annotateLogs("rika.failure.kind", failureKind(cause)),
                      Effect.andThen(
                        Effect.fail(
                          ProductOperation.OperationUnavailable.make({
                            operation: "Interactive",
                            message: Cause.pretty(cause),
                          }),
                        ),
                      ),
                    ),
                  )
                }),
              ),
              Effect.asVoid,
            ),
          )
          return teardown(false)
        })
      }),
    )
