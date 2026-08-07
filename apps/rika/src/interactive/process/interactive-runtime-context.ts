import * as InteractiveSession from "@rika/product/interactive-session"
import * as ProductOperation from "@rika/product/product-operation"
import { create as createTui } from "@rika/terminal/opentui-surface"
import type { Adapter } from "@rika/terminal/terminal-session"
import type { Model } from "@rika/terminal/terminal-state"
import type { PathTarget } from "@rika/terminal/terminal-transcript-presentation"
import type * as TranscriptPage from "@rika/product/transcript-page"
import type * as Turn from "@rika/product/turn-record"
import type * as ThreadView from "@rika/product/thread-view"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Deferred, Effect, Fiber, SubscriptionRef } from "effect"
import type { TuiLifecycle } from "./process-interrupt"
import type { InteractiveTuiOptions } from "./interactive-process-loop"

export interface InteractiveLoop {
  model: Model
  threadView: ThreadView.ThreadViewSnapshot | undefined
  requestedThreadId: string | undefined
  workingFrame: string | undefined
  renderer: Effect.Success<ReturnType<typeof createTui>> | undefined
  initialization: Fiber.Fiber<void, never> | undefined
  closed: boolean
  applyingFeedBatch: boolean
  feedPreserveAnchor: boolean
  replayTurns: Map<string, Turn.Turn>
  loadedTranscriptEntries: ReadonlyArray<TranscriptPage.Entry>
  projectionRevisions: Map<string, number>
  transcriptHasOlder: boolean
  transcriptHasNewer: boolean
  transcriptOldestCursor: TranscriptPage.PageCursor | undefined
  transcriptNewestCursor: TranscriptPage.PageCursor | undefined
  appliedDeltas: Set<string>
  activitySequence: number
  submissionSequence: number
  selectionFiber: Fiber.Fiber<void, never> | undefined
  selectionGeneration: number
  renderSuppressed: boolean
  loadingOlder: boolean
  pendingNewer: { readonly threadId: string; readonly cursor: string } | undefined
  selectionResyncs: Set<string>
  queueResyncs: Set<string>
  lifecycle: SubscriptionRef.SubscriptionRef<TuiLifecycle>
  forceQuit: Deferred.Deferred<void>
  submittedSinceIdle: boolean
  terminalPauseCount: number
  pendingJobControlPause: boolean
  releaseJobControlPause: (() => boolean) | undefined
  openingPath: boolean
}

export interface InteractiveRuntimeContext {
  readonly loop: InteractiveLoop
  readonly fork: (effect: Effect.Effect<void, never, never>) => Fiber.Fiber<void, never>
  readonly renderTimer: (effect: Effect.Effect<void, never, never>) => Fiber.Fiber<void, never>
  readonly previewTimer: (effect: Effect.Effect<void, never, never>) => Fiber.Fiber<void, never>
  readonly feedTimer: (effect: Effect.Effect<void, never, never>) => Fiber.Fiber<void, never>
  readonly session: InteractiveSession.InteractiveSession
  readonly options: InteractiveTuiOptions
  readonly recoverSession: <R>(
    effect: Effect.Effect<void, ProductOperation.OperationUnavailable, R>,
  ) => Effect.Effect<void, never, R>
  readonly resume: (effect: Effect.Effect<void, ProductOperation.OperationUnavailable>) => void
  readonly render: (immediate?: boolean) => void
}

export interface InteractiveInputContext extends InteractiveRuntimeContext {
  readonly run: <E>(effect: Effect.Effect<void, E, BunServices.BunServices>) => void
  readonly requestNewerPage: () => void
  readonly close: () => void
  readonly refreshTerminalTitle: () => void
  readonly openPath: (target: PathTarget) => void
  readonly editComposer: Effect.Effect<void, ProductOperation.OperationUnavailable, BunServices.BunServices>
  readonly consumePendingAction: () => void
  readonly loadChangedFiles: Effect.Effect<void, never, BunServices.BunServices>
  readonly adapter: Adapter
}
