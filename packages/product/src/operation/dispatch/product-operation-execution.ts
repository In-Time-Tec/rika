import * as TurnRepository from "@rika/product/turn-repository"
import { Context, Effect, Layer, PlatformError, PubSub, Scope, Semaphore } from "effect"
import { operationError } from "../operation-error"
import { makeExecutionLifecycle } from "./product-operation-execution-lifecycle"
import { makeExecutionProjection } from "./product-operation-execution-projection"
import { makeExecutionContext } from "./product-operation-execution-context"

type ThreadId = import("@rika/product/thread-record").ThreadId
type TurnId = import("@rika/product/turn-record").TurnId
type TurnTurn = import("@rika/product/turn-record").Turn
type AgentExecutionTurn = import("@rika/product/turn-record").AgentExecutionTurn
type TurnRepositoryInterface = import("@rika/product/turn-repository").Interface
type TurnRepositoryError = import("@rika/product/turn-repository").RepositoryError
type TurnRepositoryQueueFull = import("@rika/product/turn-repository").QueueFull
type ExecutionGatewayInterface = import("@rika/product/execution-gateway").Interface
type ExecutionRouteSnapshot = import("@rika/product/execution-route-snapshot").ExecutionRouteSnapshot
type ExecutionStatusStatus = import("@rika/product/execution-status").Status
type PromptPart = import("@rika/product/execution-request").PromptPart
type CreateInput = import("../../thread/repository/turn-repository-contract").CreateInput
type QueueClaim = import("../../thread/repository/turn-repository-queue").QueueClaim
type RootTurnOwnerInterface = import("../../thread/queue/root-turn-owner").Interface
type OperationError = import("../operation-error").OperationError
type OperationUnavailable = import("../contract/product-operation").OperationUnavailable
type Input = import("../contract/product-operation").Input
type ModeId = import("@rika/configuration/behavior-mode").ModeId
type InteractiveEvent = import("../interactive/interactive-runtime-event").InteractiveEvent
type InteractiveDependencyContext = import("../interactive/interactive-session-runtime").InteractiveDependencyContext
type InteractiveExecutionContext = import("../interactive/interactive-session-runtime").InteractiveExecutionContext
type PreparedTurn = import("../interactive/interactive-session-runtime").PreparedTurn
type temporaryThreadTitle = typeof import("../interactive/interactive-operation-leaves").temporaryThreadTitle

export interface ProductOperationExecution {
  readonly stopActiveExecutionWorkWithProjection: Effect.Effect<
    void,
    TurnRepositoryError,
    TurnRepository.Service | import("@rika/product/execution-gateway").Service
  >
  readonly notifyThreadSummaries: Effect.Effect<
    void,
    import("@rika/product/thread-summary-repository").RepositoryError,
    import("@rika/product/thread-summary-repository").Service
  >
  readonly notifyTurnChanged: (turn: Pick<TurnTurn, "id" | "threadId">) => Effect.Effect<void, never, never>
  readonly dispatchThreadSummaries: (
    dispatch: (event: InteractiveEvent) => void,
  ) => Effect.Effect<
    void,
    import("@rika/product/thread-summary-repository").RepositoryError,
    import("@rika/product/thread-summary-repository").Service
  >
  readonly ensureTurnSummary: (
    turn: TurnTurn,
  ) => Effect.Effect<
    void,
    OperationError | import("@rika/product/thread-summary-repository").RepositoryError,
    import("@rika/product/thread-summary-repository").Service
  >
  readonly setTurnStatus: (
    id: TurnId,
    status: ExecutionStatusStatus,
    now: number,
    responseArrived?: boolean,
  ) => Effect.Effect<
    TurnTurn,
    OperationError | import("@rika/product/thread-summary-repository").RepositoryError | TurnRepositoryError,
    import("@rika/product/thread-summary-repository").Service | TurnRepository.Service
  >
  readonly repairThreadSummaries: Effect.Effect<
    void,
    import("@rika/product/thread-summary-repository").RepositoryError,
    import("@rika/product/thread-summary-repository").Service
  >
  readonly resolveExecutionRoute: (
    mode: ModeId,
    tuning?: { readonly fastMode?: boolean },
    workspace?: string,
  ) => Effect.Effect<ExecutionRouteSnapshot, OperationError, import("@rika/product/execution-gateway").Service>
  readonly executionPrompt: (
    workspace: string,
    prompt: string,
    promptParts?: ReadonlyArray<PromptPart>,
  ) => Effect.Effect<
    { readonly prompt: string; readonly digest: string; readonly messages: ReadonlyArray<string> },
    PlatformError.PlatformError | import("@rika/product/thread-repository").RepositoryError | TurnRepositoryError,
    | import("../../context/context-resolution-service").Service
    | import("@rika/product/thread-repository").Service
    | TurnRepository.Service
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
    | import("../../context/context-resolution-service").Service
    | import("@rika/product/thread-repository").Service
    | TurnRepository.Service
    | import("@rika/extensions/execution-extension-service").ExecutionExtensionService
  >
}

export interface ProductOperationExecutionInput {
  readonly options: import("./product-operation-options").ProductLayerOptions<Error, Error, Error, Error, Error>
  readonly ownerScope: Scope.Scope
  readonly pendingTurnCapacity: number
  readonly turnMutationAdmission: Semaphore.Semaphore
  readonly turnChanges: PubSub.PubSub<void>
  readonly dirtyTurnObservers: Set<TurnId>
  readonly rootTurnOwner: RootTurnOwnerInterface
  readonly acquiredBackend: ExecutionGatewayInterface
  readonly rawBackend: ExecutionGatewayInterface
  readonly dependencyContext: InteractiveDependencyContext
  readonly executionDependencies: InteractiveExecutionContext
  readonly withExecutionAdmission: <A, E, R>(effect: Effect.Effect<A, E, R>, closed: E) => Effect.Effect<A, E, R>
  readonly extensionService:
    | import("@rika/extensions/execution-extension-service").ExecutionExtensionInterface
    | undefined
  readonly publishInteractiveActivity: (origin: number, event: InteractiveEvent) => InteractiveEvent
  readonly publishTurnSettled?: (turn: TurnTurn, responseArrived?: boolean) => Effect.Effect<void, never, never>
  readonly createObservedSubmission: (
    turns: TurnRepositoryInterface,
    submission: CreateInput,
  ) => Effect.Effect<
    { readonly turn: TurnTurn; readonly claimed: boolean },
    TurnRepositoryError | TurnRepositoryQueueFull,
    never
  >
  readonly claimTurnObserver: (
    turnId: TurnId,
    expectedStatus?: ExecutionStatusStatus,
  ) => Effect.Effect<boolean, TurnRepositoryError, never>
  readonly releaseTurnObserver: (turnId: TurnId, notify?: boolean) => Effect.Effect<void, never, never>
  readonly claimQueuedTurn: (
    threadId: ThreadId,
    now: number,
  ) => Effect.Effect<QueueClaim | undefined, TurnRepositoryError, never>
  readonly backendLayer: Layer.Layer<import("@rika/product/execution-gateway").Service>
  readonly acquiredDependencies: Layer.Layer<
    | import("@rika/product/thread-repository").Service
    | TurnRepository.Service
    | import("@rika/product/thread-summary-repository").Service
    | import("@rika/product/transcript-repository").Service
    | import("../../context/context-resolution-service").Service
    | import("@rika/extensions/execution-extension-service").ExecutionExtensionService
  >
  readonly executionStartFailureMessage: string
  readonly unavailable: (input: Input, message?: string) => OperationUnavailable
  readonly temporaryThreadTitle: temporaryThreadTitle
  readonly encodeJson: (value: unknown) => string
}

export const makeProductOperationExecution = (
  input: ProductOperationExecutionInput,
): Effect.Effect<ProductOperationExecution, Error, never> =>
  Effect.gen(function* () {
    yield* Effect.provideService(
      Context.get(input.dependencyContext, TurnRepository.Service).resetQueueClaims,
      TurnRepository.Service,
      Context.get(input.dependencyContext, TurnRepository.Service),
    )
    const lifecycle = yield* makeExecutionLifecycle(input)
    const projection = yield* makeExecutionProjection({ ...input, ...lifecycle })
    const context = yield* makeExecutionContext({
      options: input.options,
    })
    return { ...lifecycle, ...projection, ...context }
  }).pipe(Effect.mapError((error) => operationError(String(error), error)))
