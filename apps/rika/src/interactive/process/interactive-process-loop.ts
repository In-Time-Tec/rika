#!/usr/bin/env bun
import * as ProductOperation from "@rika/product/product-operation"
import * as InteractiveSession from "@rika/product/interactive-session"
import * as TranscriptPage from "@rika/product/transcript-page"
import * as InteractiveFeed from "@rika/product/resident-interactive-feed"
import * as Thread from "@rika/product/thread-record"
import * as Turn from "@rika/product/turn-record"
import * as TranscriptProjectionModel from "@rika/transcript/transcript-projection-model"
import { create as createTui } from "@rika/terminal/opentui-surface"
import { Model, initial, withModeRouteMap } from "@rika/terminal/terminal-state"
import type { ThreadItem } from "@rika/terminal/terminal-state"
type ModeRoutes = Model["modeRoutes"]
import { Effect, Fiber } from "effect"
import * as InteractiveController from "../controller/interactive-controller"
import { terminalTitleSequence, traceTuiModelEvent } from "./interactive-process"
import { makeEventRouter } from "./process-events"
import { makeProcessRuntime } from "./process-runtime"
import { initializeRenderer } from "./interactive-process-setup"

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
          loop.initialization = initializeRenderer({
            loop,
            input,
            session,
            options,
            fork,
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
        })
      }),
    )
