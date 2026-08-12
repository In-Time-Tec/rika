import * as InteractiveFeed from "@rika/product/server-interactive-feed"
import * as ProductOperation from "@rika/product/product-operation"
import { create as createTui } from "@rika/terminal/opentui-surface"
import { execute, type Adapter } from "@rika/terminal/terminal-session"
import { update } from "@rika/terminal/terminal-state-reducer"
import { Cause, Effect, Fiber } from "effect"
import type { InteractiveInputContext } from "./interactive-runtime-context"
import { initialSubmitAction } from "../input/command-input"
import { createInputHandlers } from "./interactive-process-input"
import { failureKind } from "./process-configuration"
import { settleTuiInitialization } from "./process-lifecycle"
import { workspaceGlob } from "./process-files"
import { gitOutput } from "./process-workspace"

type StartupContext = InteractiveInputContext & {
  readonly input: InteractiveFeed.InteractiveInput
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
  return fork(
    settleTuiInitialization(
      createTui({
        ...(options.makeRenderer === undefined ? {} : { makeRenderer: options.makeRenderer }),
        ...(createInputHandlers({
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
        }) as Parameters<typeof createTui>[0]),
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
          run(session.events(dispatch))
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
            return Effect.sync(() => startSelection(() => session.selectThread(input.threadId!))).pipe(
              Effect.flatMap(Fiber.join),
            )
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
  ) as Fiber.Fiber<void, never>
}
