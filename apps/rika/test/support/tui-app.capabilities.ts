import type * as ExecutionRouteSnapshot from "@rika/product/execution-route-snapshot"
import type * as InteractiveSession from "@rika/product/interactive-session"
import type * as TranscriptPage from "@rika/product/transcript-page"
import type * as Thread from "@rika/product/thread-record"
import type * as ThreadRepository from "@rika/product/thread-repository"
import type * as TranscriptRepository from "@rika/product/transcript-repository"
import type * as Turn from "@rika/product/turn-record"
import type { createTestRenderer } from "@opentui/core/testing"
import type { ModeConfiguration } from "@rika/terminal/terminal-state"
import type { Deferred, Effect } from "effect"
import type { HistoricalTranscriptFixture, TuiAppQueue } from "./tui-repositories.harness"
import type { Lane, LaneModels, Profile, ProviderHttpEnvelopeCounts } from "./tui-model.fixture"
import type { RuntimeStatePreparation } from "./tui-backend.harness"
import type { interactiveTui } from "../../src/interactive/process/lifecycle/loop"

type InteractiveConnection = Parameters<ReturnType<typeof interactiveTui>>[2]
type InteractiveConnectionState = InteractiveConnection["initialState"]
type SessionEvent = Parameters<Parameters<InteractiveSession.InteractiveSession["events"]>[0]>[0]

export interface TuiAppOptions {
  readonly script?: Lane["steps"]
  readonly initialPrompt?: ReadonlyArray<string>
  readonly lanes?: ReadonlyArray<Lane>
  readonly subagents?: ExecutionRouteSnapshot.ExecutionRouteSnapshot["subagents"]
  readonly root?: string
  readonly initialThreadId?: string
  readonly initialThreadSelected?: boolean
  readonly idStart?: number
  readonly inspectTranscript?: boolean
  readonly workspaceFiles?: Readonly<Record<string, string>>
  readonly width?: number
  readonly height?: number
  readonly initialConnectionState?: InteractiveConnectionState
  readonly holdSubmissionAdmission?: Deferred.Deferred<void>
  readonly holdCancellation?: Deferred.Deferred<void>
  readonly mapInteractiveEvent?: (event: SessionEvent) => SessionEvent
  readonly duplicateInteractiveEvent?: (event: SessionEvent) => boolean
  readonly submissionFailure?: (attempt: number) => string | undefined
  readonly newOrbThreadFailure?: string
  readonly historicalTranscriptFixture?: HistoricalTranscriptFixture
  readonly prepareRuntimeState?: RuntimeStatePreparation
  readonly modeConfiguration?: ModeConfiguration
}

export type CapturedSpans = ReturnType<Awaited<ReturnType<typeof createTestRenderer>>["captureSpans"]>

export interface TuiAppInputCapability {
  readonly type: (text: string) => ReturnType<typeof Effect.runPromise<void, never>>
  readonly paste: (text: string) => void
  readonly pressEnter: () => void
  readonly pressEscape: () => void
  readonly pressArrow: (direction: "up" | "down" | "left" | "right") => void
  readonly pressKey: (key: string, modifiers?: { ctrl?: boolean; alt?: boolean; shift?: boolean }) => void
  readonly pressPageUp: Effect.Effect<void>
  readonly pressPageDown: Effect.Effect<void>
  readonly clickText: (text: string) => Effect.Effect<void>
  readonly clickComposer: Effect.Effect<void>
  readonly submit: (prompt: string) => Effect.Effect<void>
}

export interface TuiAppSnapshotCapability {
  readonly thread: (threadId: string) => Effect.Effect<Thread.Thread | undefined, ThreadRepository.RepositoryError>
  readonly waitThread: (
    threadId: string,
    predicate: (thread: Thread.Thread) => boolean,
    timeoutMillis?: number,
  ) => Effect.Effect<Thread.Thread, ThreadRepository.RepositoryError>
  readonly transcript: (
    turnId: Turn.TurnId,
  ) => Effect.Effect<TranscriptPage.Projection | undefined, TranscriptRepository.RepositoryError>
  readonly queue: TuiAppQueue
  readonly waitTranscript: (
    turnId: Turn.TurnId,
    predicate: (projection: TranscriptPage.Projection) => boolean,
    timeoutMillis?: number,
  ) => Effect.Effect<TranscriptPage.Projection, TranscriptRepository.RepositoryError>
}

export interface TuiAppRuntimeCapability {
  readonly workspace: string
  readonly reload: Effect.Effect<void>
  readonly waitModelRequests: (count: number) => Effect.Effect<void>
  readonly waitSubmissionAdmissions: (count: number) => Effect.Effect<void>
  readonly setConnectionState: (state: InteractiveConnectionState) => Effect.Effect<void>
  readonly modelRequestCount: Effect.Effect<number>
  readonly submissionAttempts: Effect.Effect<number>
  readonly modelProviderHttpEnvelopeCounts: Effect.Effect<ProviderHttpEnvelopeCounts>
  readonly modelPrompts: ReturnType<LaneModels["promptsFor"]>
  readonly modelToolNamesFor: (profile: Profile) => Effect.Effect<ReadonlyArray<ReadonlyArray<string>>>
  readonly close: () => void
  readonly done: Effect.Effect<void>
  readonly quit: Effect.Effect<void>
}

export interface TuiAppRendererCapability {
  readonly frame: () => string
  readonly nextFrame: Effect.Effect<string>
  readonly spans: () => CapturedSpans
  readonly waitFrame: (marker: string, timeoutMillis?: number) => Effect.Effect<string>
  readonly waitFrameMatch: (predicate: (frame: string) => boolean, timeoutMillis?: number) => Effect.Effect<string>
  readonly waitCost: Effect.Effect<string>
  readonly waitGone: (marker: string, timeoutMillis?: number) => Effect.Effect<string>
  readonly waitTerminalTitle: (predicate: (title: string) => boolean, timeoutMillis?: number) => Effect.Effect<string>
  readonly settled: Effect.Effect<string>
}

export type TuiApp = TuiAppInputCapability &
  TuiAppSnapshotCapability &
  TuiAppRuntimeCapability &
  TuiAppRendererCapability
