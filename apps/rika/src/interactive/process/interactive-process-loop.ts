#!/usr/bin/env bun
import * as ProductOperation from "@rika/product/product-operation"
import * as InteractiveSession from "@rika/product/interactive-session"
import * as TranscriptPage from "@rika/product/transcript-page"
import * as InteractiveFeed from "@rika/product/resident-interactive-feed"
import * as Thread from "@rika/product/thread-record"
import * as Turn from "@rika/product/turn-record"
import * as TranscriptProjectionModel from "@rika/transcript/transcript-projection-model"
import { create as createTui } from "@rika/terminal/opentui-surface"
import { Mode, Model, initial, withModeRouteMap } from "@rika/terminal/terminal-state"
import { promptParts, expandPastedText, execute, type Action } from "@rika/terminal/terminal-session"
import type { ThreadItem } from "@rika/terminal/terminal-message"
import { selectedThreadMetadata } from "@rika/terminal/terminal-state-reducer"
type ModeRoutes = Model["modeRoutes"]
const nextMode = (mode: Mode): Mode => {
  const modes = Mode.literals
  return modes[(modes.indexOf(mode) + 1) % modes.length]!
}
const nextUsageDisplay = (display: "cost" | "tokens" | "time" | undefined): "cost" | "tokens" | "time" => {
  if (display === "cost") return "tokens"
  if (display === "tokens") return "time"
  return "cost"
}

import { canSubmit, update } from "@rika/terminal/terminal-state-reducer"
import { Cause, Effect, Fiber } from "effect"
import * as InteractiveController from "../controller/interactive-controller"
import * as Process from "./interactive-process"
import { imagePasteBlockedNotice } from "../input/prompt-input"
import { initialSubmitAction } from "../input/command-input"
import { nextSubmissionId } from "../controller/terminal-turn-submission"
import { makeEventRouter } from "./process-events"
import { makeProcessRuntime } from "./process-runtime"

export interface InteractiveTuiOptions {
  readonly editor?: string | undefined
  readonly modeRoutes?: (() => ModeRoutes | undefined) | undefined
  readonly makeRenderer?: NonNullable<Parameters<typeof createTui>[0]["makeRenderer"]>
  readonly writeTerminalTitle?: (sequence: string) => void
}

const terminalTitleSequence = Process.terminalTitleSequence
const traceTuiModelEvent = Process.traceTuiModelEvent
const settleTuiInitialization = Process.settleTuiInitialization
const pastedImagePath = Process.pastedImagePath
const persistPastedImage = Process.persistPastedImage
const pasteClipboardPng = Process.pasteClipboardPng
const workspaceGlob = Process.workspaceGlob
const gitOutput = Process.gitOutput
const failureKind = Process.failureKind

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
          const loop = {
            model: initial(input.workspace ?? process.cwd(), input.mode ?? "medium"),
            workingFrame: undefined as string | undefined,
            renderer: undefined as Effect.Success<ReturnType<typeof createTui>> | undefined,
            initialization: undefined as Fiber.Fiber<void, never> | undefined,
            closed: false,
            previewTimer: undefined as Fiber.Fiber<void, never> | undefined,
            renderTimer: undefined as Fiber.Fiber<void, never> | undefined,
            feedTimer: undefined as Fiber.Fiber<void, never> | undefined,
            applyingFeedBatch: false,
            feedPreserveAnchor: false,
            replayTurns: new Map<string, Turn.Turn>(),
            loadedTranscriptEntries: [] as ReadonlyArray<TranscriptPage.Entry>,
            projectionRevisions: new Map<string, number>(),
            liveTranscriptProjections: new Map<string, TranscriptProjectionModel.Projection>(),
            projectionStreams: new Map<string, InteractiveController.ProjectionStream>(),
            threadCostUsd: undefined as number | undefined,
            lastAvailableUsageCost: undefined as
              | Extract<Model["usageCost"], { readonly _tag: "Available" }>
              | undefined,
            transcriptHasOlder: false,
            transcriptHasNewer: false,
            transcriptOldestCursor: undefined as TranscriptPage.PageCursor | undefined,
            transcriptNewestCursor: undefined as TranscriptPage.PageCursor | undefined,
            appliedDeltas: new Set<string>(),
            activeSelectionEpoch: 0,
            submissionSequence: 0,
            fibers: new Set<Fiber.Fiber<void, never>>(),
            selectionFiber: undefined as Fiber.Fiber<void, never> | undefined,
            selectionGeneration: 0,
            renderSuppressed: false,
            loadingOlder: false,
            pendingNewer: undefined as
              | { readonly threadId: string; readonly selectionEpoch: number; readonly cursor: string }
              | undefined,
            selectionResyncs: new Set<string>(),
            queueResyncs: new Set<string>(),
            closing: false,
            interruptCancellationRequested: false,
            submittedSinceIdle: false,
            teardownStarted: false,
            terminalPauseCount: 0,
            pendingJobControlPause: false,
            releaseJobControlPause: undefined as (() => boolean) | undefined,
            openingPath: false,
          }
          if (resolvedModeRoutes !== undefined) loop.model = withModeRouteMap(loop.model, resolvedModeRoutes)
          const writeTerminalTitle =
            options.writeTerminalTitle ?? ((sequence: string) => process.stdout.write(sequence))
          const refreshTerminalTitle = () => {
            const threadId = loop.model.currentThreadId
            const title =
              loop.model.currentThreadTitle ??
              (loop.model.threads as ReadonlyArray<ThreadItem>).find((thread) => thread.id === threadId)?.title
            if (title !== undefined)
              writeTerminalTitle(
                terminalTitleSequence(title, loop.model.workspace, loop.model.busy ? loop.workingFrame : undefined),
              )
          }
          const recoverSession = <R>(
            effect: Effect.Effect<void, ProductOperation.OperationUnavailable, R>,
          ): Effect.Effect<void, never, R> =>
            effect.pipe(
              Effect.catchTag("OperationUnavailable", (error) =>
                loop.closed ? Effect.void : Effect.logError(error.message),
              ),
            )
          const requestQueueResync = (threadId: Thread.ThreadId) => {
            const key = String(threadId)
            if (loop.queueResyncs.has(key)) return
            loop.queueResyncs.add(key)
            fork(session.readQueue(threadId).pipe(Effect.ensuring(Effect.sync(() => loop.queueResyncs.delete(key)))))
          }
          const render = (immediate = false) => {
            if (loop.applyingFeedBatch) return
            if (loop.renderer === undefined || loop.renderSuppressed) return
            if (immediate) {
              if (loop.renderTimer !== undefined) fork(Fiber.interrupt(loop.renderTimer))
              loop.renderTimer = undefined
              loop.renderer.surface.update(loop.model)
              return
            }
            if (loop.renderTimer !== undefined) return
            loop.renderTimer = fork(
              Effect.sleep("16 millis").pipe(
                Effect.andThen(
                  Effect.sync(() => {
                    loop.renderTimer = undefined
                    loop.renderer?.surface.update(loop.model)
                  }),
                ),
              ),
            )
          }
          const runtime = makeProcessRuntime({ loop, fork, session, options, recoverSession, render, resume })
          const {
            teardown,
            close,
            suspend,
            run,
            requestNewerPage,
            startSelection,
            loadChangedFiles,
            watchChangedFiles,
            editComposer,
            openPath,
            adapter,
            consumePendingAction,
            requestSelectionResync,
          } = runtime
          const { feedBatcher } = makeEventRouter({
            loop,
            fork,
            session,
            refreshTerminalTitle,
            traceTuiModelEvent,
            render,
            requestSelectionResync,
            requestQueueResync,
          })
          loop.initialization = fork(
            settleTuiInitialization(
              createTui({
                ...(options.makeRenderer === undefined ? {} : { makeRenderer: options.makeRenderer }),
                workingFrame: (frame) => {
                  if (loop.workingFrame === frame) return
                  loop.workingFrame = frame
                  refreshTerminalTitle()
                },
                openPath,
                scroll: (offset) => {
                  loop.model = update(loop.model, { _tag: "ScrollMoved", offset })
                  if (offset <= 0 && !loop.loadingOlder) {
                    const threadId = loop.model.currentThreadId
                    const before = loop.transcriptOldestCursor
                    if (!loop.transcriptHasOlder || threadId === undefined || before === undefined) return
                    loop.loadingOlder = true
                    run(
                      session
                        .loadOlder(
                          threadId,
                          loop.activeSelectionEpoch,
                          before,
                          loop.loadedTranscriptEntries.map((entry) => entry.unit.key),
                        )
                        .pipe(
                          Effect.ensuring(
                            Effect.sync(() => {
                              loop.loadingOlder = false
                            }),
                          ),
                        ),
                    )
                  }
                  if (offset > 0 && !loop.loadingOlder) requestNewerPage()
                },
                scrollGeometry: (offset) => {
                  loop.model = update(loop.model, { _tag: "ScrollMoved", offset })
                },
                scrollFollow: () => {
                  loop.model = update(loop.model, { _tag: "ScrollFollowed" })
                  requestNewerPage()
                },
                paste: (text) => {
                  loop.model = update(loop.model, { _tag: "Pasted", text })
                  loop.renderer?.surface.update(loop.model)
                },
                expandPaste: (token) => {
                  loop.model = update(loop.model, { _tag: "PastedTextExpanded", token })
                  loop.renderer?.surface.update(loop.model)
                },
                pasteImage: (image) => {
                  const blocked = imagePasteBlockedNotice(loop.model)
                  if (blocked !== undefined) {
                    loop.renderer?.surface.showToast(blocked)
                    return
                  }
                  if (image !== undefined) {
                    const path = pastedImagePath(image.bytes, image.mediaType)
                    if (path === undefined) {
                      loop.renderer?.surface.showToast("Pasted image must be a non-empty PNG, JPEG, GIF, or WebP")
                      return
                    }
                    loop.model = update(loop.model, { _tag: "ImageInserted", path })
                    loop.renderer?.surface.update(loop.model)
                    run(
                      persistPastedImage(loop.model.workspace, path, image.bytes).pipe(
                        Effect.tap((persisted) =>
                          Effect.sync(() => {
                            if (persisted) return
                            loop.model = update(loop.model, { _tag: "ImageRemoved", path })
                            loop.renderer?.surface.update(loop.model)
                            loop.renderer?.surface.showToast("Pasted image could not be saved")
                          }),
                        ),
                        Effect.asVoid,
                      ),
                    )
                    return
                  }
                  run(
                    pasteClipboardPng(loop.model.workspace).pipe(
                      Effect.tap((path) =>
                        Effect.sync(() => {
                          if (path === undefined) {
                            loop.renderer?.surface.showToast(
                              "Clipboard does not contain a supported non-empty PNG image",
                            )
                            return
                          }
                          loop.model = update(loop.model, { _tag: "ImageInserted", path })
                          loop.renderer?.surface.update(loop.model)
                        }),
                      ),
                      Effect.asVoid,
                    ),
                  )
                },
                clickToggle: (unit) => {
                  loop.model = update(loop.model, { _tag: "DetailToggled", id: unit })
                  loop.renderer?.surface.update(loop.model)
                },
                usageToggle: () => {
                  loop.model = {
                    ...loop.model,
                    usageDisplay: nextUsageDisplay(loop.model.usageDisplay),
                  }
                  render()
                },
                modeToggle: () => {
                  if (loop.model.busy) return
                  loop.model = { ...loop.model, mode: nextMode(loop.model.mode) }
                  render()
                },
                key: (key) => {
                  if (key.ctrl && key.name === "c" && !loop.model.busy) {
                    close()
                    return
                  }
                  if (key.ctrl && key.name === "g") {
                    run(editComposer())
                    return
                  }
                  const wasChangedFilesOpen = loop.model.changedFilesOpen
                  const beforePreviewId = loop.model.threadSwitcher.open
                    ? selectedThreadMetadata(loop.model)?.id
                    : undefined
                  const submitting = key.name === "return" && !key.shift && !key.ctrl && canSubmit(loop.model)
                  const submission = submitting ? nextSubmissionId(loop.submissionSequence) : undefined
                  if (submission !== undefined) loop.submissionSequence = submission.sequence
                  const submissionId = submission?.id
                  const prompt = submitting ? loop.model.input : undefined
                  const parts = prompt === undefined ? undefined : promptParts(prompt, loop.model.pastedText)
                  const submittedPrompt =
                    prompt === undefined ? undefined : expandPastedText(prompt, loop.model.pastedText)
                  loop.model = update(loop.model, { _tag: "KeyPressed", key })
                  if (submitting)
                    loop.model = update(loop.model, {
                      _tag: "Submitted",
                      ...(submissionId === undefined ? {} : { submissionId }),
                    })
                  if (!wasChangedFilesOpen && loop.model.changedFilesOpen)
                    loop.model = update(loop.model, { _tag: "ChangedFilesRequested" })
                  const afterPreviewId = loop.model.threadSwitcher.open
                    ? selectedThreadMetadata(loop.model)?.id
                    : undefined
                  if (afterPreviewId !== undefined && afterPreviewId !== beforePreviewId)
                    loop.model = update(loop.model, { _tag: "ThreadPreviewRequested" })
                  loop.renderer?.surface.update(loop.model)
                  if (!wasChangedFilesOpen && loop.model.changedFilesOpen) run(loadChangedFiles())
                  if (afterPreviewId !== undefined && afterPreviewId !== beforePreviewId) {
                    if (loop.previewTimer !== undefined) fork(Fiber.interrupt(loop.previewTimer))
                    const selectedPreviewTimer = Effect.sleep("120 millis").pipe(
                      Effect.andThen(session.previewThread(afterPreviewId)),
                      Effect.ensuring(
                        Effect.sync(() => {
                          if (loop.previewTimer === selectedPreviewTimer) loop.previewTimer = undefined
                        }),
                      ),
                      recoverSession,
                      fork,
                    )
                    loop.previewTimer = selectedPreviewTimer
                  }
                  if (submittedPrompt !== undefined && submittedPrompt.length > 0 && parts !== undefined) {
                    loop.submittedSinceIdle = true
                    execute(adapter, {
                      _tag: "Submit",
                      prompt: submittedPrompt,
                      parts,
                      mode: loop.model.mode,
                      tuning: { fastMode: loop.model.fastMode },
                      ...(submissionId === undefined ? {} : { submissionId }),
                    })
                  }
                  if (!loop.model.busy && loop.model.activeTurnId === undefined && loop.model.activity === undefined)
                    loop.submittedSinceIdle = false
                  const action = loop.model.pendingAction as Action | undefined
                  if (action !== undefined) consumePendingAction()
                },
                resize: (width, height) => {
                  loop.model = update(loop.model, { _tag: "Resized", width, height })
                  loop.renderer?.surface.update(loop.model)
                },
                composerResize: (height) => {
                  loop.model = update(loop.model, { _tag: "ComposerHeightChanged", height })
                  loop.renderer?.surface.update(loop.model)
                },
                sidebarResize: (width) => {
                  loop.model = update(loop.model, { _tag: "SidebarWidthChanged", width })
                  loop.renderer?.surface.update(loop.model)
                },
                threadSidebarSelect: (index) => {
                  loop.model = update(loop.model, { _tag: "ThreadSidebarSelectionConfirmed", index })
                  loop.renderer?.surface.update(loop.model)
                  const action = loop.model.pendingAction as Action | undefined
                  if (action !== undefined) consumePendingAction()
                },
                threadPreviewScroll: (offset) => {
                  loop.model = update(loop.model, { _tag: "ThreadPreviewScrolled", offset })
                  loop.renderer?.surface.update(loop.model)
                },
              }),
              () => loop.closed,
              (created) => Effect.sync(() => created.releaseTerminal()),
            ).pipe(
              Effect.tap((created) =>
                Effect.sync(() => {
                  if (created === undefined) return
                  loop.renderer = created
                  if (loop.closed) {
                    created.releaseTerminal()
                    return
                  }
                  if (loop.pendingJobControlPause) {
                    loop.pendingJobControlPause = false
                    suspend()
                  }
                  loop.model = update(loop.model, { _tag: "FilesRequested" })
                  created.surface.update(loop.model)
                  run(Effect.logInfo("tui.renderer.started"))
                  if (loop.closed) return
                  run(session.events(feedBatcher.offer))
                  run(watchChangedFiles)
                  run(
                    workspaceGlob(loop.model.workspace, "**/*", 10_000).pipe(
                      Effect.tap((files) =>
                        Effect.sync(() => {
                          loop.model = update(loop.model, { _tag: "FilesReplaced", files: files.toSorted() })
                          created.surface.update(loop.model)
                        }),
                      ),
                      Effect.catch((error) =>
                        Effect.sync(() => {
                          loop.model = update(loop.model, { _tag: "FilesFailed", message: error.message })
                          created.surface.update(loop.model)
                        }).pipe(Effect.andThen(Effect.logWarning(`workspace file index failed: ${error.message}`))),
                      ),
                      Effect.asVoid,
                    ),
                  )
                  run(
                    gitOutput(["git", "-C", loop.model.workspace, "symbolic-ref", "--short", "HEAD"]).pipe(
                      Effect.tap(([text, exit]) =>
                        Effect.sync(() => {
                          const branch = text.trim()
                          if (exit === 0 && branch.length > 0 && branch !== "HEAD") {
                            loop.model = update(loop.model, { _tag: "BranchDetected", branch })
                            created.surface.update(loop.model)
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
                        initialSubmitAction(input.prompt, loop.model.mode) === undefined
                          ? Effect.void
                          : Effect.sync(() => {
                              execute(adapter, initialSubmitAction(input.prompt, loop.model.mode)!)
                            }),
                      ),
                    ),
                  )
                }),
              ),
              Effect.catchCause((cause) =>
                Effect.sync(() => {
                  if (loop.closed) return
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
