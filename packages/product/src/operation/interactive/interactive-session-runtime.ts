import { Effect, Exit, Scope, Semaphore, Context, PubSub, PlatformError } from "effect"
import { makeInteractiveSessionState, type InteractiveSessionState } from "./interactive-session-state"
import { makeInteractiveSessionComposition } from "./interactive-session-composition"
import { makeInteractiveImplementation } from "./interactive-session-interface"
import {
  makeInteractiveExecutionComponents,
  makeInteractiveFollowingComponents,
  makeInteractiveTranscriptComponents,
  makeInteractiveSupervisionComponents,
} from "./interactive-session-runtime-components"
import { ignoreInteractiveEvent } from "./interactive-session-following"

type ThreadId = import("@rika/product/thread-record").ThreadId
type TurnId = import("@rika/product/turn-record").TurnId
type TurnTurn = import("@rika/product/turn-record").Turn
type AgentExecutionTurn = import("@rika/product/turn-record").AgentExecutionTurn
type TurnRepositoryInterface = import("@rika/product/turn-repository").Interface
type TurnRepositoryError = import("@rika/product/turn-repository").RepositoryError
type ExecutionGatewayInterface = import("@rika/product/execution-gateway").Interface
type ExecutionRouteSnapshot = import("@rika/product/execution-route-snapshot").ExecutionRouteSnapshot
type ExecutionEventEvent = import("@rika/product/execution-event").Event
type ExecutionEventResult = import("@rika/product/execution-event").Result
type ExecutionStatusStatus = import("@rika/product/execution-status").Status
type PromptPart = import("@rika/product/execution-request").PromptPart
type CreateInput = import("../../thread/repository/turn-repository-contract").CreateInput
type QueueSubmission = import("../../thread/repository/turn-repository-queue").Submission
type QueueClaim = import("../../thread/repository/turn-repository-queue").QueueClaim
type ExecutionIngestInterface = import("../../execution/ingest/execution-ingest-service").Interface
type RootTurnOwnerInterface = import("../../thread/queue/root-turn-owner").Interface
type ModeId = import("@rika/configuration/behavior-mode").ModeId
type InteractiveSession = import("./interactive-session").InteractiveSession
type InteractiveEvent = import("./interactive-event").InteractiveEvent
type ProductLayerOptions<
  ThreadError extends Error,
  TurnError extends Error,
  BackendError extends Error,
  ThreadSummaryError extends Error = never,
  TranscriptError extends Error = never,
  UsageError extends Error = never,
> = import("../dispatch/product-operation-options").ProductLayerOptions<
  ThreadError,
  TurnError,
  BackendError,
  ThreadSummaryError,
  TranscriptError,
  UsageError
>
type InteractiveOperationFeed = import("./interactive-operation-feed").InteractiveOperationFeed
type SelectionEpochState = import("./interactive-thread-selection").SelectionEpochState
type ThreadContext = import("./interactive-thread-context").ThreadContext
type OperationError = import("../operation-error").OperationError
type operationError = typeof import("../operation-error").operationError
type queueMutationEvent = typeof import("../dispatch/product-operation-runtime-support").queueMutationEvent
type executeShellCommand = typeof import("./interactive-operation-leaves").executeShellCommand
type recordedShellStartedEvent = typeof import("./interactive-operation-leaves").recordedShellStartedEvent
type recordedShellSettledEvents = typeof import("./interactive-operation-leaves").recordedShellSettledEvents
type temporaryThreadTitle = typeof import("./interactive-operation-leaves").temporaryThreadTitle
type dispatchInteractiveFailure = typeof import("./interactive-session-errors").dispatchInteractiveFailure

export type InteractiveExecutionContextServices =
  | import("@rika/product/thread-repository").Service
  | import("@rika/product/turn-repository").Service
  | import("@rika/product/thread-summary-repository").Service
  | import("@rika/product/transcript-repository").Service
  | import("@rika/product/usage-repository").Service
  | import("../../context/context-resolution-service").Service
  | import("@rika/extensions/execution-extension-service").ExecutionExtensionService
  | import("@rika/product/execution-gateway").Service

export type InteractiveDependencyContext = Context.Context<
  | import("@rika/product/thread-repository").Service
  | import("@rika/product/turn-repository").Service
  | import("@rika/product/thread-summary-repository").Service
  | import("@rika/product/transcript-repository").Service
  | import("@rika/product/usage-repository").Service
  | import("../../context/context-resolution-service").Service
  | import("@rika/extensions/execution-extension-service").ExecutionExtensionService
>

export type InteractiveExecutionContext = Context.Context<InteractiveExecutionContextServices>

export type PreparedTurn = {
  readonly prompt: string
  readonly promptParts: ReadonlyArray<PromptPart> | undefined
  readonly messages: ReadonlyArray<string>
}

export interface InteractiveSessionInput {
  readonly options: ProductLayerOptions<Error, Error, Error, Error, Error, Error>
  readonly executionIngest: ExecutionIngestInterface
  readonly pendingTurnCapacity: number
  readonly rootTurnOwner: RootTurnOwnerInterface
  readonly turnMutationAdmission: Semaphore.Semaphore
  readonly resolveExecutionRoute: (
    mode: ModeId,
    tuning?: { readonly fastMode?: boolean },
    workspace?: string,
  ) => Effect.Effect<ExecutionRouteSnapshot, OperationError, import("@rika/product/execution-gateway").Service>
  readonly notifyThreadSummaries: Effect.Effect<
    void,
    import("@rika/product/thread-summary-repository").RepositoryError,
    import("@rika/product/thread-summary-repository").Service
  >
  readonly ensureIngest: (threadId: ThreadId, turnId: TurnId) => Effect.Effect<void, OperationError, never>
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
    | import("../../context/context-resolution-service").Service
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
  readonly projectExecutionResult: (
    threadId: ThreadId,
    result: ExecutionEventResult,
  ) => Effect.Effect<
    void,
    OperationError | import("@rika/product/thread-summary-repository").RepositoryError,
    import("@rika/product/thread-summary-repository").Service
  >
  readonly deliverResultEvents: (
    turnId: TurnId,
    events: ReadonlyArray<ExecutionEventEvent>,
    delivered?: ReadonlySet<string>,
  ) => void
  readonly executionDependencies: InteractiveExecutionContext
  readonly claimTurnObserver: (
    turnId: TurnId,
    expectedStatus?: ExecutionStatusStatus,
  ) => Effect.Effect<boolean, TurnRepositoryError, never>
  readonly releaseTurnObserver: (turnId: TurnId, notify?: boolean) => Effect.Effect<void, never, never>
  readonly acquiredBackend: ExecutionGatewayInterface
  readonly turnChanges: PubSub.PubSub<void>
  readonly dirtyTurnObservers: Set<TurnId>
  readonly usageRepository: import("@rika/product/usage-repository").Interface
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
  readonly selectionInitialTurnWindow: number
  readonly selectionInitialEntryWindow: number
  readonly encodeJson: (value: unknown) => string
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
  readonly readThreadContext: (threadId: string) => Effect.Effect<ThreadContext, Error>
  readonly publishTurnSettled: (turn: TurnTurn, responseArrived?: boolean) => Effect.Effect<void, never, never>
}

export type InteractiveRuntimeContext = InteractiveSessionInput &
  InteractiveSessionState & {
    readonly workspace: string
    readonly sessionId: number
    readonly serverOwner: boolean
    readonly emit: InteractiveOperationFeed["emit"]
    readonly dispatchFailure: dispatchInteractiveFailure
    readonly admit: ReturnType<typeof makeInteractiveSessionComposition>["admit"]
    readonly admitLocal: ReturnType<typeof makeInteractiveSessionComposition>["admitLocal"]
    readonly attachFeed: ReturnType<typeof makeInteractiveSessionComposition>["attachFeed"]
  }

export interface InteractiveSessionRuntimeResult {
  readonly session: InteractiveSession
  readonly supervise: Effect.Effect<
    void,
    | OperationError
    | import("@rika/product/execution-gateway").WatchTurnFailure
    | import("@rika/product/execution-gateway").InspectTurnFailure
    | TurnRepositoryError
    | import("@rika/product/transcript-repository").RepositoryError,
    never
  >
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

export const makeInteractiveSession = (
  input: InteractiveSessionInput,
): ((
  workspace: string,
  settings?: { readonly initialThreadId?: string; readonly serverOwner?: boolean },
) => Effect.Effect<InteractiveSessionRuntimeResult, OperationError, never>) =>
  Effect.fn("ProductOperation.makeInteractiveSession")(function* (
    workspace: string,
    settings: { readonly initialThreadId?: string; readonly serverOwner?: boolean } = {},
  ) {
    const sessionId = input.nextSessionId()
    const state: InteractiveSessionState = yield* makeInteractiveSessionState({
      sessionId,
      executionIngest: input.executionIngest,
      publishInteractiveActivity: input.publishInteractiveActivity,
      activitySequence: input.activitySequence,
      options: input.options,
      initialThreadId: settings.initialThreadId,
      serverOwner: settings.serverOwner ?? false,
    })
    const typedLifecycleAdmission: Semaphore.Semaphore = state.lifecycleAdmission
    const typedGetLifecycle: () => "open" | "closed" = state.getLifecycle
    const typedSetLifecycle: (value: "open" | "closed") => void = state.setLifecycle
    const typedInteractiveSinks: Map<number, unknown> = input.interactiveSinks
    const typedSessionThreadViews: Map<number, unknown> = input.sessionThreadViews
    const typedOperationFeed: InteractiveOperationFeed = state.operationFeed
    const typedSessionScope: Scope.Scope = state.sessionScope
    const runtimeInput = {
      ...input,
      ...state,
      workspace,
      sessionId,
      serverOwner: settings.serverOwner ?? false,
      emit: state.emit,
      dispatchFailure: state.dispatchFailure,
      admit: state.composition.admit,
      admitLocal: state.composition.admitLocal,
      attachFeed: state.composition.attachFeed,
    }
    const execution = makeInteractiveExecutionComponents(runtimeInput, state)
    const following = makeInteractiveFollowingComponents(runtimeInput, execution)
    const transcript = makeInteractiveTranscriptComponents(runtimeInput, state)
    const supervision = makeInteractiveSupervisionComponents(runtimeInput, state, following, execution)
    const implementation = makeInteractiveImplementation({
      ...runtimeInput,
      ...execution,
      ...following,
      ...transcript,
      ...supervision,
      getCurrentSelectionEpoch: state.getCurrentSelectionEpoch,
      getSelectedThreadId: state.getSelectedThreadId,
      getActiveSelectionState: state.getActiveSelectionState,
      selectionMatches: (candidate: SelectionEpochState | undefined, threadId: string, epoch: number) =>
        candidate !== undefined && String(candidate.thread.id) === threadId && candidate.epoch === epoch,
    })
    const session: InteractiveSession = {
      events: (dispatch) => state.composition.attachFeed(implementation.events(dispatch)),
      submit: (prompt, mode, parts, tuning, submissionId) =>
        state.composition.admit(implementation.submit(prompt, mode, parts, tuning, submissionId)),
      newThread: state.composition.admitLocal(implementation.newThread),
      shell: (threadId, command, incognito) =>
        state.composition.admitLocal(implementation.shell(threadId, command, incognito)),
      editQueued: (turnId, prompt) => state.composition.admitLocal(implementation.editQueued(turnId, prompt)),
      dequeue: (turnId) => state.composition.admitLocal(implementation.dequeue(turnId)),
      steerQueued: (turnId, text) => state.composition.admitLocal(implementation.steerQueued(turnId, text)),
      steer: (text, targetTurnId) => state.composition.admitLocal(implementation.steer(text, targetTurnId)),
      interruptAndSend: (prompt) => state.composition.admitLocal(implementation.interruptAndSend(prompt)),
      cancel: state.composition.admitLocal(implementation.cancel),
      quit: implementation.quit,
      selectThread: (threadId, epoch) => state.composition.admitLocal(implementation.selectThread(threadId, epoch)),
      readQueue: (threadId) => state.composition.admitLocal(implementation.readQueue(threadId)),
      loadOlder: (threadId, epoch, before, loadedKeys) =>
        state.composition.admitLocal(implementation.loadOlder(threadId, epoch, before, loadedKeys)),
      loadNewer: (threadId, epoch, after) =>
        state.composition.admitLocal(implementation.loadNewer(threadId, epoch, after)),
      previewThread: (threadId) => state.composition.admitLocal(implementation.previewThread(threadId)),
      reopenThread: (epoch) => state.composition.admitLocal(implementation.reopenThread(epoch)),
    }
    return {
      session,
      supervise: supervision.supervise,
      watchClaimed: (turnId: TurnId) => following.watchClaimedTurn(turnId, ignoreInteractiveEvent),
      close: typedLifecycleAdmission.withPermits(1)(
        Effect.suspend(() => {
          if (typedGetLifecycle() === "closed") return Effect.void
          typedSetLifecycle("closed")
          typedInteractiveSinks.delete(sessionId)
          typedSessionThreadViews.delete(sessionId)
          return typedOperationFeed.close.pipe(Effect.andThen(Scope.close(typedSessionScope, Exit.void)))
        }),
      ),
    }
  })
