#!/usr/bin/env bun
import * as ProductOperation from "@rika/product/product-operation"
import * as InteractiveSession from "@rika/product/interactive-session"
import * as TranscriptPage from "@rika/product/transcript-page"
import * as InteractiveFeed from "@rika/product/server-interactive-feed"
import * as Turn from "@rika/product/turn-record"
import { create as createTui } from "@rika/terminal/opentui-surface"
import { Model, initial, withModeRouteMap } from "@rika/terminal/terminal-state"
import type { ThreadItem } from "@rika/terminal/terminal-state"
type ModeRoutes = Model["modeRoutes"]
import { Deferred, Effect, Exit, Fiber, FiberHandle, FiberSet, Scope } from "effect"
import { terminalTitleSequence } from "./interactive-process"
import { makeEventRouter } from "./process-events"
import { makeProcessRuntime } from "./process-runtime"
import { initializeRenderer } from "./interactive-process-setup"
import type { InteractiveLoop } from "./interactive-runtime-context"

export interface InteractiveTuiOptions {
  readonly editor?: string | undefined
  readonly modeRoutes?: (() => ModeRoutes | undefined) | undefined
  readonly makeRenderer?: NonNullable<Parameters<typeof createTui>[0]["makeRenderer"]>
  readonly writeTerminalTitle?: (sequence: string) => void
}

export const interactiveTui =
  (options: InteractiveTuiOptions) =>
  (
    input: InteractiveFeed.InteractiveInput,
    session: InteractiveSession.InteractiveSession,
  ): Effect.Effect<void, ProductOperation.OperationUnavailable> =>
    Effect.uninterruptible(
      Effect.gen(function* () {
        if (options.makeRenderer === undefined && (!process.stdin.isTTY || !process.stdout.isTTY)) return
        const appScope = yield* Scope.make()
        const fork = yield* FiberSet.makeRuntime<never, void, never>().pipe(
          Effect.provideService(Scope.Scope, appScope),
        )
        const renderTimer = yield* FiberHandle.makeRuntime<never, never, void>().pipe(
          Effect.provideService(Scope.Scope, appScope),
        )
        const previewTimer = yield* FiberHandle.makeRuntime<never, never, void>().pipe(
          Effect.provideService(Scope.Scope, appScope),
        )
        const feedTimer = yield* FiberHandle.makeRuntime<never, never, void>().pipe(
          Effect.provideService(Scope.Scope, appScope),
        )
        const resolvedModeRoutes = options.modeRoutes?.()
        return yield* Effect.callback<void, ProductOperation.OperationUnavailable>((resume) => {
          const loop: InteractiveLoop = {
            model: initial(input.workspace ?? process.cwd(), input.mode ?? "medium"),
            threadView: undefined,
            requestedThreadId: input.threadId,
            workingFrame: undefined as string | undefined,
            renderer: undefined as Effect.Success<ReturnType<typeof createTui>> | undefined,
            initialization: undefined as Fiber.Fiber<void, never> | undefined,
            closed: false,
            applyingFeedBatch: false,
            feedPreserveAnchor: false,
            replayTurns: new Map<string, Turn.Turn>(),
            loadedTranscriptEntries: [] as ReadonlyArray<TranscriptPage.Entry>,
            projectionRevisions: new Map<string, number>(),
            transcriptHasOlder: false,
            transcriptHasNewer: false,
            transcriptOldestCursor: undefined as TranscriptPage.PageCursor | undefined,
            transcriptNewestCursor: undefined as TranscriptPage.PageCursor | undefined,
            appliedDeltas: new Set<string>(),
            activitySequence: 0,
            submissionSequence: 0,
            selectionFiber: undefined as Fiber.Fiber<void, never> | undefined,
            selectionGeneration: 0,
            renderSuppressed: false,
            loadingOlder: false,
            pendingNewer: undefined as { readonly threadId: string; readonly cursor: string } | undefined,
            selectionResyncs: new Set<string>(),
            queueResyncs: new Set<string>(),
            closing: false,
            forceQuit: Deferred.makeUnsafe<void>(),
            lastInterruptAt: undefined,
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
          const render = (immediate = false) => {
            if (loop.applyingFeedBatch) return
            if (loop.renderer === undefined || loop.renderSuppressed) return
            if (immediate) {
              renderTimer(Effect.void)
              loop.renderer.surface.update(loop.model)
              return
            }
            renderTimer(
              Effect.sleep("16 millis").pipe(
                Effect.andThen(Effect.sync(() => loop.renderer?.surface.update(loop.model))),
              ),
            )
          }
          const runtime = makeProcessRuntime({
            loop,
            fork,
            renderTimer,
            previewTimer,
            feedTimer,
            session,
            options,
            recoverSession,
            render,
            resume,
          })
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
            feedTimer,
            session,
            refreshTerminalTitle,
            render,
            requestSelectionResync,
          })
          loop.initialization = initializeRenderer({
            loop,
            input,
            session,
            options,
            fork,
            renderTimer,
            previewTimer,
            feedTimer,
            run,
            requestNewerPage,
            close,
            refreshTerminalTitle,
            openPath,
            editComposer,
            recoverSession,
            render,
            consumePendingAction,
            loadChangedFiles,
            adapter,
            feedBatcher,
            watchChangedFiles,
            suspend,
            startSelection,
            resume,
          })
          return teardown(false)
        }).pipe(Effect.ensuring(Scope.close(appScope, Exit.void)))
      }),
    )
