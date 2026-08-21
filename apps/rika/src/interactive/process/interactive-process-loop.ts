#!/usr/bin/env bun
import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import type * as BunServices from "@effect/platform-bun/BunServices"
import * as ProductOperation from "@rika/product/product-operation"
import * as InteractiveSession from "@rika/product/interactive-session"
import type * as InteractiveConnection from "@rika/product/interactive-connection"
import * as InteractiveFeed from "@rika/product/interactive-feed"
import * as Turn from "@rika/product/turn-record"
import { create as createTui } from "@rika/terminal/opentui-surface"
import { initial, withModeConfiguration, type ModeConfiguration } from "@rika/terminal/terminal-state"
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

const connectionLabel = (status: InteractiveConnection.Status): string | undefined => {
  if (status === "connected") return undefined
  if (status === "connecting") return "Connecting to hosted Rika"
  if (status === "reconnecting") return "Reconnecting to hosted Rika"
  const labels: Record<Exclude<InteractiveConnection.Status, "connected" | "connecting" | "reconnecting">, string> = {
    authenticating: "Authenticating with hosted Rika",
    "personal-owner": "Owner: Personal",
    "organization-owner": "Owner: Organization",
    "local-placement": "Placement: this local checkout",
    "e2b-placement": "Placement: E2B",
    "executor-waiting": "Waiting for the selected executor; placement will not change",
    "executor-connecting": "Connecting the selected executor",
    "executor-connected": "Selected executor connected",
    "workspace-preparing": "Preparing Workspace",
    "workspace-setup": "Setting up Workspace",
    "workspace-resuming": "Resuming Workspace",
    "lease-active": "Executor lease active",
    retrying: "Retry available",
    "approval-required": "Approval required",
    "unknown-operation": "Operation outcome unknown",
    terminal: "Thread terminal",
    presence: "Another controller is attached",
  }
  return labels[status]
}

export const interactiveTui =
  (options: InteractiveTuiOptions) =>
  (
    input: InteractiveFeed.InteractiveInput,
    session: InteractiveSession.InteractiveSession,
    connection: InteractiveConnection.Connection,
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
        const initialConnectionStatus = connectionLabel(connection.initialStatus)
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
                const connectionStatus = connectionLabel(status)
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
