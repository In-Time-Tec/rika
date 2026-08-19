#!/usr/bin/env bun
import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import type * as BunServices from "@effect/platform-bun/BunServices"
import * as ProductOperation from "@rika/product/product-operation"
import * as InteractiveSession from "@rika/product/interactive-session"
import * as InteractiveFeed from "@rika/product/server-interactive-feed"
import type * as ServerInteractiveConnection from "@rika/product/server-interactive-connection"
import * as Turn from "@rika/product/turn-record"
import { create as createTui } from "@rika/terminal/opentui-surface"
import { Model, initial, withModeConfiguration, type ModeConfiguration } from "@rika/terminal/terminal-state"
import { update } from "@rika/terminal/terminal-state-reducer"
import type { ThreadItem } from "@rika/terminal/terminal-state"
import { Crypto, Deferred, Effect, Exit, Fiber, FiberHandle, FiberSet, Scope, Stream, SubscriptionRef } from "effect"
import { terminalTitleSequence } from "./interactive-process"
import { makeEventRouter } from "./process-events"
import { makeProcessRuntime } from "./process-runtime"
import { initializeRenderer } from "./interactive-process-setup"
import type { InteractiveLoop } from "./interactive-runtime-context"
import type { TuiLifecycle } from "./process-interrupt"
import { provideLayerScoped } from "./process-layer"

export interface InteractiveTuiOptions {
  readonly editor?: string | undefined
  readonly modeConfiguration?: (() => ModeConfiguration | undefined) | undefined
  readonly rememberMode?: ((mode: string) => Effect.Effect<void, never, BunServices.BunServices>) | undefined
  readonly makeRenderer?: NonNullable<Parameters<typeof createTui>[0]["makeRenderer"]>
  readonly writeTerminalTitle?: (sequence: string) => void
}

export const interactiveTui =
  (options: InteractiveTuiOptions) =>
  (
    input: InteractiveFeed.InteractiveInput,
    session: InteractiveSession.InteractiveSession,
    connection: ServerInteractiveConnection.Connection,
  ): Effect.Effect<void, ProductOperation.OperationUnavailable> =>
    Effect.gen(function* () {
      if (options.makeRenderer === undefined && (!process.stdin.isTTY || !process.stdout.isTTY)) return
      const crypto = yield* Crypto.Crypto
      const runSync = Effect.runSyncWith(yield* Effect.context<never>())
      const nextSteeringRequestId = () => `rika:steer:${runSync(crypto.randomUUIDv4)}`
      const appScope = yield* Scope.make()
      const fork = yield* FiberSet.makeRuntime<never, void, never>().pipe(Effect.provideService(Scope.Scope, appScope))
      const renderTimer = yield* FiberHandle.makeRuntime<never, never, void>().pipe(
        Effect.provideService(Scope.Scope, appScope),
      )
      const previewTimer = yield* FiberHandle.makeRuntime<never, never, void>().pipe(
        Effect.provideService(Scope.Scope, appScope),
      )
      const lifecycle = yield* SubscriptionRef.make<TuiLifecycle>({ _tag: "Running" })
      const resolvedModeConfiguration = options.modeConfiguration?.()
      const rememberedMode = resolvedModeConfiguration?.rememberedMode
      const configuredRememberedMode =
        resolvedModeConfiguration !== undefined &&
        rememberedMode !== undefined &&
        Object.hasOwn(resolvedModeConfiguration.routes, rememberedMode)
          ? rememberedMode
          : undefined
      return yield* Effect.callback<void, ProductOperation.OperationUnavailable>((resume) => {
        let renderPending = false
        let initialConnectionStatus: Model["connectionStatus"]
        if (connection.initialStatus === "connecting") initialConnectionStatus = "Connecting"
        else if (connection.initialStatus === "reconnecting") initialConnectionStatus = "Reconnecting"
        const loop: InteractiveLoop = {
          model: {
            ...initial(
              input.workspace ?? process.cwd(),
              input.mode ?? configuredRememberedMode ?? resolvedModeConfiguration?.defaultMode,
            ),
            connectionStatus: initialConnectionStatus,
          },
          threadView: undefined,
          modelPreview: undefined,
          requestedThreadId: input.threadId,
          workingFrame: undefined as string | undefined,
          renderer: undefined as Effect.Success<ReturnType<typeof createTui>> | undefined,
          initialization: undefined as Fiber.Fiber<void, never> | undefined,
          closed: false,
          replayTurns: new Map<string, Turn.Turn>(),
          projectionRevisions: new Map<string, number>(),
          appliedDeltas: new Set<string>(),
          activitySequence: 0,
          submissionSequence: 0,
          selectionFiber: undefined as Fiber.Fiber<void, never> | undefined,
          selectionGeneration: 0,
          renderSuppressed: false,
          selectionResyncs: new Set<string>(),
          queueResyncs: new Set<string>(),
          lifecycle,
          forceQuit: Deferred.makeUnsafe<void>(),
          submittedSinceIdle: false,
          terminalPauseCount: 0,
          pendingJobControlPause: false,
          releaseJobControlPause: undefined as (() => boolean) | undefined,
          openingPath: false,
          ctrlCMenuVisible: false,
        }
        if (resolvedModeConfiguration !== undefined)
          loop.model = withModeConfiguration(loop.model, resolvedModeConfiguration)
        const writeTerminalTitle = options.writeTerminalTitle ?? ((sequence: string) => process.stdout.write(sequence))
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
          if (loop.renderer === undefined || loop.renderSuppressed) return
          if (immediate) {
            renderPending = false
            renderTimer(Effect.void)
            loop.renderer.surface.update(loop.model)
            return
          }
          if (renderPending) return
          renderPending = true
          renderTimer(
            Effect.sleep("16 millis").pipe(
              Effect.andThen(
                Effect.sync(() => {
                  renderPending = false
                  loop.renderer?.surface.update(loop.model)
                }),
              ),
            ),
          )
        }
        const runtime = makeProcessRuntime({
          loop,
          fork,
          renderTimer,
          previewTimer,
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
          startSelection,
          loadChangedFiles,
          watchChangedFiles,
          editComposer,
          openPath,
          adapter,
          consumePendingAction,
          requestSelectionResync,
        } = runtime
        const { dispatch } = makeEventRouter({
          loop,
          refreshTerminalTitle,
          render,
          requestSelectionResync,
        })
        fork(
          connection.statusChanges.pipe(
            Stream.runForEach((status) =>
              Effect.sync(() => {
                let connectionStatus: Model["connectionStatus"]
                if (status === "connecting") connectionStatus = "Connecting"
                else if (status === "reconnecting") connectionStatus = "Reconnecting"
                loop.model = update(loop.model, {
                  _tag: "ConnectionStatusChanged",
                  ...(connectionStatus === undefined ? {} : { status: connectionStatus }),
                })
                loop.renderer?.surface.update(loop.model)
              }),
            ),
          ),
        )
        loop.initialization = initializeRenderer({
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
        })
        return teardown(false)
      }).pipe(Effect.ensuring(Scope.close(appScope, Exit.void)))
    }).pipe(provideLayerScoped(BunCrypto.layer))
