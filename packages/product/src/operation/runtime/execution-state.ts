import { Context, Effect, PubSub, RcMap, Scope, Semaphore, Layer } from "effect"
import * as ThreadRepository from "@rika/product/thread-repository"
import * as TurnRepository from "@rika/product/turn-repository"
import * as ThreadDeletion from "../../thread/lifecycle/deletion"
import * as ProductOperationFoundation from "../foundation/composition"
import { operationError } from "../error"
import * as ProductOperationExecutionRuntime from "./execution"
import type { ProductOperationExecution } from "./execution"
import { executionStartFailureMessage, temporaryThreadTitle } from "../interactive/shell"
import { queueMutationEvent as queueMutationEventValue } from "./support"

type ThreadId = import("@rika/product/thread-record").ThreadId
type TurnId = import("@rika/product/turn-record").TurnId
type TurnTurn = import("@rika/product/turn-record").Turn
type CreateInput = import("../../thread/repository/turn-contract").CreateInput
type QueueSubmission = import("../../thread/repository/turn-queue").Submission
type QueueClaim = import("../../thread/repository/turn-queue").QueueClaim
type Status = import("@rika/product/execution-status").Status
type ExecutionGatewayInterface = import("@rika/product/execution-gateway").Interface
type TurnRepositoryInterface = import("@rika/product/turn-repository").Interface
type TurnRepositoryError = import("@rika/product/turn-repository").RepositoryError
type TurnRepositoryQueueFull = import("@rika/product/turn-repository").QueueFull
type ExecutionExtensionsExecutionExtensionInterface =
  import("@rika/extensions/execution-extension-service").ExecutionExtensionInterface
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
type queueMutationEvent = typeof import("./support").queueMutationEvent
type staleQueuedTurnsError = typeof import("../../thread/queue/pending-policy").staleQueuedTurnsError
type OperationUnavailable = import("../contract/product").OperationUnavailable
type Input = import("../contract/product").Input
type InteractiveEvent = import("../interactive/session-event").InteractiveEvent
type OperationError = import("../error").OperationError
type InteractiveDependencyContext = import("../interactive/session").InteractiveDependencyContext
type InteractiveExecutionContext = import("../interactive/session").InteractiveExecutionContext

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
  readonly encodeJson: <Value>(value: Value) => string
  readonly staleQueuedTurnsError: staleQueuedTurnsError
  readonly queuedTurnPromoteMaxAgeMs: number
  readonly queueMutationEvent?: queueMutationEvent
}

export interface ProductOperationExecutionState extends ProductOperationExecution {
  readonly ownerScope: Scope.Scope
  readonly pendingTurnCapacity: number
  readonly watchedThreadIds: () => Set<string>
  readonly queueMutationEvent: queueMutationEvent
  readonly withThreadMutation: <A, E, R>(threadId: ThreadId, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  readonly turnChanges: PubSub.PubSub<void>
  readonly dirtyTurnObservers: Set<TurnId>
  readonly rootTurnOwner: RootTurnOwnerInterface
  readonly extensionService: ExecutionExtensionsExecutionExtensionInterface | undefined
  readonly deleteThread: (threadId: ThreadId) => Effect.Effect<void, Error>
  readonly acquiredDependencies: Layer.Layer<
    | import("@rika/product/thread-repository").Service
    | import("@rika/product/turn-repository").Service
    | import("@rika/product/thread-summary-repository").Service
    | import("@rika/product/transcript-repository").Service
    | import("../../context/resolution-service").Service
    | import("@rika/extensions/execution-extension-service").ExecutionExtensionService
  >
  readonly closeAdmissions: Effect.Effect<void>
  readonly rawBackend: ExecutionGatewayInterface
  readonly executionSessionLifecycle: import("@rika/product/execution-session-lifecycle").Interface
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
  readonly releaseTurnObserver: (
    threadId: ThreadId,
    turnId: TurnId,
    notify?: boolean,
  ) => Effect.Effect<void, never, never>
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
    const threadMutationAdmissions = yield* RcMap.make({
      lookup: () => Semaphore.make(1),
    }).pipe(Effect.provideService(Scope.Scope, ownerScope))
    const withThreadMutation = <A, E, R>(threadId: ThreadId, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
      Effect.scoped(
        RcMap.get(threadMutationAdmissions, String(threadId)).pipe(
          Effect.flatMap((admission) => admission.withPermits(1)(effect)),
        ),
      )
    const turnChanges = yield* PubSub.sliding<void>(1)
    const dirtyTurnObservers = new Set<TurnId>()
    const watched = () => watchedThreadIds(sessionThreadViews)
    const foundation = yield* ProductOperationFoundation.makeProductOperationFoundation({ options, ownerScope }).pipe(
      Effect.provideService(Scope.Scope, ownerScope),
      Effect.mapError((error) => operationError(String(error), error)),
    )
    const {
      rootTurnOwner,
      extensionService,
      acquiredDependencies,
      closeAdmissions,
      rawBackend,
      executionSessionLifecycle,
      acquiredBackend,
      backendLayer,
      dependencyContext,
      executionDependencies,
    } = foundation
    const threadDeletion = ThreadDeletion.make({
      threads: Context.get(dependencyContext, ThreadRepository.Service),
      turns: Context.get(dependencyContext, TurnRepository.Service),
      sessions: executionSessionLifecycle,
      rootTurns: rootTurnOwner,
      withThreadMutation,
    })
    yield* threadDeletion.reconcile
    const threadRepository = Context.get(dependencyContext, ThreadRepository.Service)
    const requireAdmission = Effect.fn("ProductOperation.requireThreadAdmission")(function* (threadId: ThreadId) {
      const thread = yield* threadRepository
        .get(threadId)
        .pipe(Effect.mapError((error) => TurnRepository.RepositoryError.make({ message: String(error) })))
      if (thread === undefined)
        return yield* TurnRepository.RepositoryError.make({ message: `Thread ${threadId} does not exist` })
    })
    const createForSubmission = (turns: TurnRepositoryInterface, submission: CreateInput) =>
      withThreadMutation(
        submission.threadId,
        requireAdmission(submission.threadId).pipe(
          Effect.andThen(turns.createForSubmission(submission)),
          Effect.mapError((error) => operationError(String(error), error)),
        ),
      )
    const claimTurnObserver = (turnId: TurnId, expectedStatus?: Status) => rootTurnOwner.claim(turnId, expectedStatus)
    const releaseTurnObserver = (threadId: ThreadId, turnId: TurnId, notify = true) =>
      Effect.uninterruptible(
        rootTurnOwner
          .release(threadId, turnId)
          .pipe(
            Effect.tap((reobserve) =>
              notify || reobserve
                ? Effect.sync(() => dirtyTurnObservers.add(turnId)).pipe(
                    Effect.andThen(PubSub.publish(turnChanges, undefined)),
                  )
                : Effect.void,
            ),
          ),
      )
    const createObservedSubmission = (turns: TurnRepositoryInterface, submission: CreateInput) =>
      Effect.gen(function* () {
        yield* requireAdmission(submission.threadId)
        const turn = yield* turns.createForSubmission(submission)
        return turn.status === "queued"
          ? { turn, claimed: false }
          : { turn, claimed: yield* rootTurnOwner.claim(turn.id, turn.status) }
      }).pipe((effect) => withThreadMutation(submission.threadId, effect))
    const claimQueuedTurn = (threadId: ThreadId, now: number) =>
      requireAdmission(threadId).pipe(Effect.andThen(rootTurnOwner.claimQueued(threadId, now)))
    const execution = yield* ProductOperationExecutionRuntime.makeProductOperationExecution({
      options,
      ownerScope,
      pendingTurnCapacity,
      withThreadMutation,
      turnChanges,
      dirtyTurnObservers,
      rootTurnOwner,
      acquiredBackend,
      rawBackend,
      dependencyContext,
      executionDependencies,
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
      withThreadMutation,
      turnChanges,
      dirtyTurnObservers,
      rootTurnOwner,
      extensionService,
      deleteThread: threadDeletion.request,
      acquiredDependencies,
      closeAdmissions,
      rawBackend,
      executionSessionLifecycle,
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
