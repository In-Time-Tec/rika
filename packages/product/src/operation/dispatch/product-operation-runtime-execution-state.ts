import { Effect, PubSub, Scope, Semaphore, Ref, Layer } from "effect"
import { makeProductOperationFoundation } from "./product-operation-foundation"
import { operationError } from "../operation-error"
import { makeProductOperationExecution, type ProductOperationExecution } from "./product-operation-execution"
import { executionStartFailureMessage, temporaryThreadTitle } from "../interactive/interactive-operation-leaves"
import { queueMutationEvent as queueMutationEventValue } from "./product-operation-runtime-support"

type ThreadId = import("@rika/product/thread-record").ThreadId
type TurnId = import("@rika/product/turn-record").TurnId
type TurnTurn = import("@rika/product/turn-record").Turn
type CreateInput = import("../../thread/repository/turn-repository-contract").CreateInput
type QueueSubmission = import("../../thread/repository/turn-repository-queue").Submission
type QueueClaim = import("../../thread/repository/turn-repository-queue").QueueClaim
type Status = import("@rika/product/execution-status").Status
type ExecutionGatewayInterface = import("@rika/product/execution-gateway").Interface
type TurnRepositoryInterface = import("@rika/product/turn-repository").Interface
type TurnRepositoryError = import("@rika/product/turn-repository").RepositoryError
type TurnRepositoryQueueFull = import("@rika/product/turn-repository").QueueFull
type ExecutionExtensionsExecutionExtensionInterface =
  import("@rika/extensions/execution-extension-service").ExecutionExtensionInterface
type RootTurnOwnerInterface = import("../../thread/queue/root-turn-owner").Interface
type ProductLayerOptions<
  ThreadError extends Error,
  TurnError extends Error,
  BackendError extends Error,
  ThreadSummaryError extends Error = never,
  TranscriptError extends Error = never,
> = import("./product-operation-options").ProductLayerOptions<
  ThreadError,
  TurnError,
  BackendError,
  ThreadSummaryError,
  TranscriptError
>
type queueMutationEvent = typeof import("./product-operation-runtime-support").queueMutationEvent
type staleQueuedTurnsError = typeof import("../../thread/queue/pending-turn-policy").staleQueuedTurnsError
type OperationUnavailable = import("../contract/product-operation").OperationUnavailable
type Input = import("../contract/product-operation").Input
type InteractiveEvent = import("../interactive/interactive-runtime-event").InteractiveEvent
type OperationError = import("../operation-error").OperationError
type InteractiveDependencyContext = import("../interactive/interactive-session-runtime").InteractiveDependencyContext
type InteractiveExecutionContext = import("../interactive/interactive-session-runtime").InteractiveExecutionContext

const watchedThreadIds = (sessionThreadViews: Map<number, () => string | undefined>) =>
  new Set(
    [...sessionThreadViews.values()].flatMap((view) => {
      const id = view()
      return id === undefined ? [] : [id]
    }),
  )

export interface ProductOperationExecutionStateInput {
  readonly options: ProductLayerOptions<Error, Error, Error, Error, Error>
  readonly ownerScope: Scope.Scope
  readonly publishInteractiveActivity: (origin: number, event: InteractiveEvent) => InteractiveEvent
  readonly publishTurnSettled: (turn: TurnTurn, responseArrived?: boolean) => Effect.Effect<void, never, never>
  readonly interactiveSinks: Map<number, (origin: number, event: InteractiveEvent) => void>
  readonly sessionThreadViews: Map<number, () => string | undefined>
  readonly activitySequence: number
  readonly unavailable: (input: Input, message?: string) => OperationUnavailable
  readonly operationError: typeof operationError
  readonly encodeJson: (value: unknown) => string
  readonly staleQueuedTurnsError: staleQueuedTurnsError
  readonly queuedTurnPromoteMaxAgeMs: number
  readonly queueMutationEvent?: queueMutationEvent
}

export interface ProductOperationExecutionState extends ProductOperationExecution {
  readonly ownerScope: Scope.Scope
  readonly pendingTurnCapacity: number
  readonly watchedThreadIds: () => Set<string>
  readonly queueMutationEvent: queueMutationEvent
  readonly turnMutationAdmission: Semaphore.Semaphore
  readonly turnChanges: PubSub.PubSub<void>
  readonly dirtyTurnObservers: Set<TurnId>
  readonly rootTurnOwner: RootTurnOwnerInterface
  readonly extensionService: ExecutionExtensionsExecutionExtensionInterface | undefined
  readonly acquiredDependencies: Layer.Layer<
    | import("@rika/product/thread-repository").Service
    | import("@rika/product/turn-repository").Service
    | import("@rika/product/thread-summary-repository").Service
    | import("@rika/product/transcript-repository").Service
    | import("../../context/context-resolution-service").Service
    | import("@rika/extensions/execution-extension-service").ExecutionExtensionService
  >
  readonly withExecutionAdmission: <A, E, R>(effect: Effect.Effect<A, E, R>, closed: E) => Effect.Effect<A, E, R>
  readonly replacementAdmission: Semaphore.Semaphore
  readonly replacementState: Ref.Ref<{ closed: boolean; active: number }>
  readonly rawBackend: ExecutionGatewayInterface
  readonly acquiredBackend: ExecutionGatewayInterface
  readonly backendLayer: Layer.Layer<import("@rika/product/execution-gateway").Service>
  readonly dependencyContext: InteractiveDependencyContext
  readonly executionDependencies: InteractiveExecutionContext
  readonly createForSubmission: (
    turns: TurnRepositoryInterface,
    submission: CreateInput,
  ) => Effect.Effect<QueueSubmission, OperationError, never>
  readonly claimTurnObserver: (
    turnId: TurnId,
    expectedStatus?: Status,
  ) => Effect.Effect<boolean, TurnRepositoryError, never>
  readonly releaseTurnObserver: (turnId: TurnId, notify?: boolean) => Effect.Effect<void, never, never>
  readonly createObservedSubmission: (
    turns: TurnRepositoryInterface,
    submission: CreateInput,
  ) => Effect.Effect<
    { readonly turn: TurnTurn; readonly claimed: boolean },
    TurnRepositoryError | TurnRepositoryQueueFull,
    never
  >
  readonly claimQueuedTurn: (
    threadId: ThreadId,
    now: number,
  ) => Effect.Effect<QueueClaim | undefined, TurnRepositoryError, never>
}

export const buildProductOperationExecutionState = (
  input: ProductOperationExecutionStateInput,
): Effect.Effect<ProductOperationExecutionState, Error, never> =>
  Effect.gen(function* () {
    const {
      options,
      ownerScope: rawOwnerScope,
      publishInteractiveActivity,
      publishTurnSettled,
      sessionThreadViews,
    } = input
    const ownerScope: Scope.Scope = rawOwnerScope
    const pendingTurnCapacity = Math.max(0, Math.floor(options.pendingTurnCapacity ?? 64))
    const turnMutationAdmission = yield* Semaphore.make(1)
    const createForSubmission = (turns: TurnRepositoryInterface, submission: CreateInput) =>
      turnMutationAdmission.withPermits(1)(
        turns.createForSubmission(submission).pipe(Effect.mapError((error) => operationError(String(error), error))),
      )
    const turnChanges = yield* PubSub.sliding<void>(1)
    const dirtyTurnObservers = new Set<TurnId>()
    const watched = () => watchedThreadIds(sessionThreadViews)
    const foundation = yield* makeProductOperationFoundation({ options, ownerScope }).pipe(
      Effect.provideService(Scope.Scope, ownerScope),
      Effect.mapError((error) => operationError(String(error), error)),
    )
    const {
      rootTurnOwner,
      extensionService,
      acquiredDependencies,
      withExecutionAdmission,
      replacementAdmission,
      replacementState,
      rawBackend,
      acquiredBackend,
      backendLayer,
      dependencyContext,
      executionDependencies,
    } = foundation
    const claimTurnObserver = (turnId: TurnId, expectedStatus?: Status) => rootTurnOwner.claim(turnId, expectedStatus)
    const releaseTurnObserver = (turnId: TurnId, notify = true) =>
      Effect.uninterruptible(
        rootTurnOwner
          .release(turnId)
          .pipe(
            Effect.tap(() =>
              notify
                ? Effect.sync(() => dirtyTurnObservers.add(turnId)).pipe(
                    Effect.andThen(PubSub.publish(turnChanges, undefined)),
                  )
                : Effect.void,
            ),
          ),
      )
    const createObservedSubmission = (turns: TurnRepositoryInterface, submission: CreateInput) =>
      Effect.gen(function* () {
        const turn = yield* turns.createForSubmission(submission)
        return turn.status === "queued"
          ? { turn, claimed: false }
          : { turn, claimed: yield* rootTurnOwner.claim(turn.id, turn.status) }
      }).pipe(turnMutationAdmission.withPermits(1))
    const claimQueuedTurn = (threadId: ThreadId, now: number) => rootTurnOwner.claimQueued(threadId, now)
    const execution = yield* makeProductOperationExecution({
      options,
      ownerScope,
      pendingTurnCapacity,
      turnMutationAdmission,
      turnChanges,
      dirtyTurnObservers,
      rootTurnOwner,
      acquiredBackend,
      rawBackend,
      dependencyContext,
      executionDependencies,
      withExecutionAdmission,
      extensionService,
      publishInteractiveActivity,
      publishTurnSettled,
      createObservedSubmission,
      claimTurnObserver,
      releaseTurnObserver,
      claimQueuedTurn,
      backendLayer,
      acquiredDependencies,
      executionStartFailureMessage,
      unavailable: input.unavailable,
      temporaryThreadTitle,
      encodeJson: input.encodeJson,
    })
    return {
      ownerScope,
      pendingTurnCapacity,
      watchedThreadIds: watched,
      queueMutationEvent: input.queueMutationEvent ?? queueMutationEventValue,
      turnMutationAdmission,
      turnChanges,
      dirtyTurnObservers,
      rootTurnOwner,
      extensionService,
      acquiredDependencies,
      withExecutionAdmission,
      replacementAdmission,
      replacementState,
      rawBackend,
      acquiredBackend,
      backendLayer,
      dependencyContext,
      executionDependencies,
      createForSubmission,
      claimTurnObserver,
      releaseTurnObserver,
      createObservedSubmission,
      claimQueuedTurn,
      ...execution,
    }
  })
