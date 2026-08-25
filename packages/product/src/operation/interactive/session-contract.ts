import type * as Thread from "@rika/product/thread-record"
import type * as ExecutionRequest from "@rika/product/execution-request"
import type * as ExecutionProjection from "@rika/product/execution-projection"
import type { ModeId } from "@rika/configuration/behavior-mode"
import type { Context, Deferred, Effect, PlatformError, PubSub, Semaphore } from "effect"
import type { OperationUnavailable } from "../contract/product"
import type { InteractiveEvent as ClientEvent } from "./event"
import type { InteractiveEvent } from "./session-event"
import type { InteractiveSessionState } from "./session-state"
import type * as InteractiveSessionStateRuntime from "./session-state"
import type { InteractiveOperationFeed } from "./view/feed"

export interface InteractiveSession {
  readonly events: (dispatch: (event: ClientEvent) => void) => Effect.Effect<void, OperationUnavailable>
  readonly currentView: () => import("@rika/product/thread-view").ThreadViewSnapshot | undefined
  readonly projectionCheckpoint: (turnId: string) => ExecutionProjection.Checkpoint | undefined
  readonly submit: (
    prompt: string,
    mode?: ModeId,
    promptParts?: ReadonlyArray<ExecutionRequest.PromptPart>,
    modelTuning?: { readonly fastMode?: boolean },
    submissionId?: string,
  ) => Effect.Effect<void, OperationUnavailable>
  readonly shell: (
    threadId: Thread.ThreadId | undefined,
    command: string,
    incognito: boolean,
  ) => Effect.Effect<void, OperationUnavailable>
  readonly editQueued: (turnId: string, prompt: string) => Effect.Effect<void, OperationUnavailable>
  readonly dequeue: (turnId: string) => Effect.Effect<void, OperationUnavailable>
  readonly steerQueued: (turnId: string, text: string, requestId: string) => Effect.Effect<void, OperationUnavailable>
  readonly steer: (text: string, requestId: string, targetTurnId?: string) => Effect.Effect<void, OperationUnavailable>
  readonly approveAuthorization: (
    turnId: string,
    authorizationId: string,
    checkpoint?: ExecutionProjection.Checkpoint,
  ) => Effect.Effect<void, OperationUnavailable>
  readonly denyAuthorization: (
    turnId: string,
    authorizationId: string,
    checkpoint?: ExecutionProjection.Checkpoint,
  ) => Effect.Effect<void, OperationUnavailable>
  readonly interruptAndSend: (prompt: string, targetTurnId?: string) => Effect.Effect<void, OperationUnavailable>
  readonly cancel: (target?: {
    readonly turnId?: string
    readonly submissionId?: string
    readonly threadId?: string
  }) => Effect.Effect<void, OperationUnavailable>
  readonly quit: Effect.Effect<void, OperationUnavailable>
  readonly newThread: Effect.Effect<void, OperationUnavailable>
  readonly newOrbThread?: Effect.Effect<void, OperationUnavailable>
  readonly pauseOrb?: Effect.Effect<void, OperationUnavailable>
  readonly resumeOrb?: Effect.Effect<void, OperationUnavailable>
  readonly enableRemoteThreadCreation?: Effect.Effect<void, OperationUnavailable>
  readonly disableRemoteThreadCreation?: Effect.Effect<void, OperationUnavailable>
  readonly archiveThread: Effect.Effect<void, OperationUnavailable>
  readonly archiveAndNewThread: Effect.Effect<void, OperationUnavailable>
  readonly selectThread: (threadId: string) => Effect.Effect<void, OperationUnavailable>
  readonly readQueue: (threadId: string) => Effect.Effect<void, OperationUnavailable>
  readonly previewThread: (threadId: string, requestId: number) => Effect.Effect<void, OperationUnavailable>
  readonly reopenThread: Effect.Effect<void, OperationUnavailable>
}

type ThreadId = import("@rika/product/thread-record").ThreadId
type TurnId = import("@rika/product/turn-record").TurnId
type TurnTurn = import("@rika/product/turn-record").Turn
type AgentExecutionTurn = import("@rika/product/turn-record").AgentExecutionTurn
type TurnRepositoryInterface = import("@rika/product/turn-repository").Interface
type TurnRepositoryError = import("@rika/product/turn-repository").RepositoryError
type ExecutionGatewayInterface = import("@rika/product/execution-gateway").Interface
type ExecutionRouteSnapshot = import("@rika/product/execution-route-snapshot").ExecutionRouteSnapshot
type ExecutionStatusStatus = import("@rika/product/execution-status").Status
type PromptPart = import("@rika/product/execution-request").PromptPart
type CreateInput = import("../../thread/repository/turn-contract").CreateInput
type QueueSubmission = import("../../thread/repository/turn-queue").Submission
type QueueClaim = import("../../thread/repository/turn-queue").QueueClaim
type RootTurnOwnerInterface = import("../../thread/queue/root-owner").Interface
type ProductLayerOptions<
  ThreadError extends Error,
  TurnError extends Error,
  BackendError extends Error,
  ThreadSummaryError extends Error = never,
  TranscriptError extends Error = never,
> = import("../foundation/options").ProductLayerOptions<
  ThreadError,
  TurnError,
  BackendError,
  ThreadSummaryError,
  TranscriptError
>
type OperationError = import("../error").OperationError
type operationError = typeof import("../error").operationError
type queueMutationEvent = typeof import("../runtime/support").queueMutationEvent
type executeShellCommand = typeof import("./shell").executeShellCommand
type recordedShellStartedEvent = typeof import("./shell").recordedShellStartedEvent
type recordedShellSettledEvents = typeof import("./shell").recordedShellSettledEvents
type temporaryThreadTitle = typeof import("./shell").temporaryThreadTitle
type dispatchInteractiveFailure = typeof import("./session-state").dispatchInteractiveFailure

export type InteractiveExecutionContextServices =
  | import("@rika/product/thread-repository").Service
  | import("@rika/product/turn-repository").Service
  | import("@rika/product/thread-summary-repository").Service
  | import("@rika/product/transcript-repository").Service
  | import("../../context/resolution-service").Service
  | import("@rika/extensions/execution-extension-service").ExecutionExtensionService
  | import("@rika/product/execution-gateway").Service

export type InteractiveDependencyContext = Context.Context<
  | import("@rika/product/thread-repository").Service
  | import("@rika/product/turn-repository").Service
  | import("@rika/product/thread-summary-repository").Service
  | import("@rika/product/transcript-repository").Service
  | import("../../context/resolution-service").Service
  | import("@rika/extensions/execution-extension-service").ExecutionExtensionService
>

export type InteractiveExecutionContext = Context.Context<InteractiveExecutionContextServices>

export type PreparedTurn = {
  readonly prompt: string
  readonly promptParts: ReadonlyArray<PromptPart> | undefined
  readonly messages: ReadonlyArray<string>
}

export interface InteractiveSessionInput {
  readonly options: ProductLayerOptions<Error, Error, Error, Error, Error>
  readonly pendingTurnCapacity: number
  readonly rootTurnOwner: RootTurnOwnerInterface
  readonly turnMutationAdmission: Semaphore.Semaphore
  readonly resolveExecutionRoute: (
    mode?: ModeId,
    tuning?: { readonly fastMode?: boolean },
    workspace?: string,
  ) => Effect.Effect<ExecutionRouteSnapshot, OperationError, import("@rika/product/execution-gateway").Service>
  readonly notifyThreadSummaries: Effect.Effect<
    void,
    import("@rika/product/thread-summary-repository").RepositoryError,
    import("@rika/product/thread-summary-repository").Service
  >
  readonly prepareExecution: (
    turn: AgentExecutionTurn,
    workspace: string,
    persist?: boolean,
  ) => Effect.Effect<
    PreparedTurn,
    | OperationError
    | PlatformError.PlatformError
    | import("@rika/product/thread-repository").RepositoryError
    | TurnRepositoryError
    | import("@rika/extensions/execution-extension-service").NoGeneration,
    | import("../../context/resolution-service").Service
    | import("@rika/product/thread-repository").Service
    | import("@rika/product/turn-repository").Service
    | import("@rika/extensions/execution-extension-service").ExecutionExtensionService
  >
  readonly setTurnStatus: (
    id: TurnId,
    status: ExecutionStatusStatus,
    now: number,
    responseArrived?: boolean,
  ) => Effect.Effect<
    TurnTurn,
    OperationError | import("@rika/product/thread-summary-repository").RepositoryError | TurnRepositoryError,
    import("@rika/product/thread-summary-repository").Service | import("@rika/product/turn-repository").Service
  >
  readonly executionDependencies: InteractiveExecutionContext
  readonly claimTurnObserver: (
    turnId: TurnId,
    expectedStatus?: ExecutionStatusStatus,
  ) => Effect.Effect<boolean, TurnRepositoryError, never>
  readonly releaseTurnObserver: (turnId: TurnId, notify?: boolean) => Effect.Effect<void, never, never>
  readonly acquiredBackend: ExecutionGatewayInterface
  readonly turnChanges: PubSub.PubSub<void>
  readonly dirtyTurnObservers: Set<TurnId>
  readonly createForSubmission: (
    turns: TurnRepositoryInterface,
    submission: CreateInput,
  ) => Effect.Effect<QueueSubmission, OperationError, never>
  readonly stopActiveExecutionWorkWithProjection: Effect.Effect<
    void,
    TurnRepositoryError,
    import("@rika/product/turn-repository").Service | import("@rika/product/execution-gateway").Service
  >
  readonly publishInteractiveActivity: (origin: number, event: InteractiveEvent) => InteractiveEvent
  readonly temporaryThreadTitle: temporaryThreadTitle
  readonly ensureTurnSummary: (
    turn: TurnTurn,
  ) => Effect.Effect<
    void,
    OperationError | import("@rika/product/thread-summary-repository").RepositoryError,
    import("@rika/product/thread-summary-repository").Service
  >
  readonly queueMutationEvent: queueMutationEvent
  readonly notifyTurnChanged: (turn: Pick<TurnTurn, "id" | "threadId">) => Effect.Effect<void, never, never>
  readonly claimQueuedTurn: (
    threadId: ThreadId,
    now: number,
  ) => Effect.Effect<QueueClaim | undefined, TurnRepositoryError, never>
  readonly dependencyContext: InteractiveDependencyContext
  readonly sessionThreadViews: Map<number, () => string | undefined>
  readonly interactiveSinks: Map<number, (origin: number, event: InteractiveEvent) => void>
  readonly encodeJson: <Value>(value: Value) => string
  readonly isTerminalStatus: (status: ExecutionStatusStatus) => boolean
  readonly executionStartFailureMessage: string
  readonly dispatchThreadSummaries: (
    dispatch: (event: InteractiveEvent) => void,
  ) => Effect.Effect<
    void,
    import("@rika/product/thread-summary-repository").RepositoryError,
    import("@rika/product/thread-summary-repository").Service
  >
  readonly recordedShellStartedEvent: recordedShellStartedEvent
  readonly recordedShellSettledEvents: recordedShellSettledEvents
  readonly executeShellCommand: executeShellCommand
  readonly nextSessionId: () => number
  readonly activitySequence: number
  readonly operationError: operationError
  readonly publishTurnSettled: (turn: TurnTurn, responseArrived?: boolean) => Effect.Effect<void, never, never>
}

export type InteractiveRuntimeContext = InteractiveSessionInput &
  InteractiveSessionState & {
    readonly workspace: string
    readonly sessionId: number
    readonly recoveryOwner: boolean
    readonly observeExecution: boolean
    readonly supervisionInitialized: Deferred.Deferred<void, InteractiveSupervisionError>
    readonly emit: InteractiveOperationFeed["emit"]
    readonly dispatchFailure: dispatchInteractiveFailure
    readonly admit: ReturnType<typeof InteractiveSessionStateRuntime.makeInteractiveSessionComposition>["admit"]
    readonly admitLocal: ReturnType<typeof InteractiveSessionStateRuntime.makeInteractiveSessionComposition>["admitLocal"]
    readonly attachFeed: ReturnType<typeof InteractiveSessionStateRuntime.makeInteractiveSessionComposition>["attachFeed"]
  }

export type InteractiveSupervisionError =
  | OperationError
  | import("@rika/product/execution-gateway").StartTurnFailure
  | import("@rika/product/execution-gateway").WatchTurnFailure
  | import("@rika/product/execution-gateway").InspectTurnFailure
  | TurnRepositoryError
  | import("@rika/product/transcript-repository").RepositoryError

export interface InteractiveSessionRuntimeResult {
  readonly session: InteractiveSession
  readonly supervise: Effect.Effect<void, InteractiveSupervisionError, never>
  readonly initialized: Effect.Effect<void, InteractiveSupervisionError, never>
  readonly watchClaimed: (
    turnId: TurnId,
  ) => Effect.Effect<
    void,
    | OperationError
    | import("@rika/product/execution-gateway").WatchTurnFailure
    | TurnRepositoryError
    | import("@rika/product/transcript-repository").RepositoryError
    | import("@rika/product/thread-summary-repository").RepositoryError
    | import("@rika/product/thread-repository").RepositoryError,
    InteractiveExecutionContextServices
  >
  readonly close: Effect.Effect<void, never, never>
}
