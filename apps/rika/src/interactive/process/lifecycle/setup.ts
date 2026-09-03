import * as InteractiveFeed from "@rika/product/interactive-feed"
import type * as InteractiveConnection from "@rika/product/interactive-connection"
import * as ProductOperation from "@rika/product/product-operation"
import { create as createTui } from "@rika/terminal/opentui-surface"
import { execute, type Adapter } from "@rika/terminal/terminal-session"
import { update } from "@rika/terminal/terminal-state-reducer"
import { Cause, Effect, Fiber, Stream } from "effect"
import type { InteractiveInputContext } from "../runtime/context"
import { initialSubmitAction } from "../../input/command"
import { nextSubmissionId } from "../../controller/turn-submission"
import { createInputHandlers } from "../input/reader"
import { failureKind } from "../runtime/configuration"
import { settleTuiInitialization } from "./contract"
import { workspaceGlob } from "../workspace/files"
import { gitOutput } from "../workspace/context"

type StartupContext = InteractiveInputContext & {
  readonly input: InteractiveFeed.InteractiveInput
  readonly connection: InteractiveConnection.Connection
  readonly close: () => void
  readonly refreshTerminalTitle: () => void
  readonly openPath: Parameters<typeof createInputHandlers>[0]["openPath"]
  readonly consumePendingAction: () => void
  readonly loadChangedFiles: InteractiveInputContext["loadChangedFiles"]
  readonly adapter: Adapter
  readonly dispatch: Parameters<InteractiveInputContext["session"]["events"]>[0]
  readonly watchChangedFiles: InteractiveInputContext["loadChangedFiles"]
  readonly suspend: () => void
  readonly startSelection: (
    select: () => Effect.Effect<void, ProductOperation.OperationUnavailable>,
  ) => Fiber.Fiber<void, never>
}

export const initializeRenderer = (context: StartupContext): Fiber.Fiber<void, never> => {
  const {
    loop,
    input,
    connection,
    session,
    options,
    fork,
    renderTimer,
    previewTimer,
    run,
    nextSteeringRequestId,
    close,
    refreshTerminalTitle,
    openPath,
    editComposer,
    recoverSession,
    render,
    consumePendingAction,
    loadChangedFiles,
    adapter,
    dispatch,
    watchChangedFiles,
    suspend,
    startSelection,
    resume,
  } = context
  const inputContext = {
    loop,
    session,
    run,
    nextSteeringRequestId,
    fork,
    renderTimer,
    previewTimer,
    close,
    refreshTerminalTitle,
    openPath,
    editComposer,
    recoverSession,
    render,
    consumePendingAction,
    loadChangedFiles,
    adapter,
    startSelection,
  }
  const inputHandlers = createInputHandlers(
    options.rememberMode === undefined ? inputContext : { ...inputContext, rememberMode: options.rememberMode },
  )
  const warning = (event: string, cause: unknown) => {
    const error = cause instanceof Error ? cause : new Error(String(cause))
    fork(
      Effect.logWarning(event).pipe(
        Effect.annotateLogs({
          "rika.failure.kind": error.name,
          "rika.failure.message": error.message,
          "rika.failure.stack": error.stack ?? error.message,
        }),
      ),
    )
  }
  const handlers = { ...inputHandlers, warning }
  const tuiOptions = options.makeRenderer === undefined ? handlers : { ...handlers, makeRenderer: options.makeRenderer }
  return fork(
    settleTuiInitialization(
      createTui(tuiOptions),
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
          created.surface.onNextFrameCompleted(options.onFirstDraw ?? (() => undefined))
          created.surface.update(loop.model)
          run(Effect.logInfo("tui.renderer.started"))
          if (loop.closed) return
          run(recoverSession(session.events(dispatch)))
          run(Effect.yieldNow.pipe(Effect.andThen(recoverSession(session.refreshThreads))))
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
          const ensureInitialSelection = () => {
            if (input.threadId === undefined) return Effect.void
            const threadId = input.threadId
            if (String(session.currentView()?.thread.id) === threadId) return Effect.void
            return Effect.sync(() => startSelection(() => session.selectThread(threadId))).pipe(
              Effect.flatMap(Fiber.join),
            )
          }
          const awaitConnected = Stream.concat(Stream.make(connection.initialState), connection.stateChanges).pipe(
            Stream.filter((state) => state.connectivity === "connected"),
            Stream.runHead,
            Effect.asVoid,
          )
          const initialAction = initialSubmitAction(input.prompt, loop.model.mode)
          run(
            awaitConnected.pipe(
              Effect.andThen(ensureInitialSelection),
              Effect.andThen(
                initialAction === undefined
                  ? Effect.void
                  : Effect.sync(() => {
                      const submission = nextSubmissionId(loop.submissionSequence)
                      loop.submissionSequence = submission.sequence
                      execute(adapter, { ...initialAction, submissionId: submission.id })
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
}
