import type * as RootTurnOwner from "../../thread/queue/root-turn-owner"
import type * as Thread from "../../thread/model/thread-record"
import type * as Turn from "../../thread/model/turn-record"
import type * as TurnRepository from "../../thread/repository/turn-repository"
import type * as TurnQueuePromotion from "../../thread/repository/turn-repository-queue"
import type { staleQueuedTurnsError } from "../../thread/queue/pending-turn-policy"
import type { Input, OperationUnavailable } from "../contract/product-operation"
import type { OperationError } from "../operation-error"
import type { InteractiveEvent } from "../interactive/interactive-runtime-event"
import type { PreparedTurn } from "../interactive/interactive-session-runtime"
import type { ModeId } from "@rika/configuration/behavior-mode"
import type { CreateInput } from "../../thread/repository/turn-repository-contract"
import type { Effect } from "effect"

export type NoninteractiveInput = Extract<Input, { readonly _tag: "Run" | "Review" }>

export type AgentExecutionTurn = Turn.AgentExecutionTurn

export type PreparedExecutionTurn = PreparedTurn

type ExecutionError =
  | OperationError
  | TurnRepository.RepositoryError
  | import("@rika/product/thread-summary-repository").RepositoryError
  | import("@rika/product/thread-repository").RepositoryError
  | import("effect").PlatformError.PlatformError
  | import("@rika/extensions/execution-extension-service").NoGeneration

export interface Dependencies {
  readonly defaultWorkspace: string
  readonly pendingTurnCapacity: number
  readonly makeThreadId: Effect.Effect<Thread.ThreadId>
  readonly makeTurnId: Effect.Effect<Turn.TurnId>
  readonly resolveExecutionRoute: (
    mode: ModeId,
    tuning?: undefined,
    workspace?: string,
  ) => Effect.Effect<import("@rika/product/execution-route-snapshot").ExecutionRouteSnapshot, OperationError, never>
  readonly createObservedSubmission: (
    turns: TurnRepository.Interface,
    input: CreateInput,
  ) => Effect.Effect<
    { readonly turn: Turn.Turn; readonly claimed: boolean },
    TurnRepository.RepositoryError | TurnRepository.QueueFull,
    never
  >
  readonly ensureTurnSummary: (
    turn: Turn.Turn,
  ) => Effect.Effect<void, OperationError | import("@rika/product/thread-summary-repository").RepositoryError, never>
  readonly setTurnStatus: (
    id: Turn.TurnId,
    status: import("@rika/product/execution-status").Status,
    now: number,
    responseArrived?: boolean,
  ) => Effect.Effect<
    Turn.Turn,
    OperationError | TurnRepository.RepositoryError | import("@rika/product/thread-summary-repository").RepositoryError,
    never
  >
  readonly publishInteractiveActivity: (origin: number, event: InteractiveEvent) => InteractiveEvent
  readonly rootTurnOwner: RootTurnOwner.Interface
  readonly prepareExecution: (
    turn: Turn.AgentExecutionTurn,
    workspace: string,
  ) => Effect.Effect<PreparedTurn, ExecutionError, never>
  readonly claimQueuedTurn: (
    threadId: Thread.ThreadId,
    now: number,
  ) => Effect.Effect<TurnQueuePromotion.QueueClaim | undefined, TurnRepository.RepositoryError, never>
  readonly releaseTurnObserver: (turnId: Turn.TurnId) => Effect.Effect<void, never, never>
  readonly queueMutationEvent: (queue: TurnQueuePromotion.QueueItemChange) => InteractiveEvent
  readonly executionDependencies: import("../interactive/interactive-session-runtime").InteractiveExecutionContext
  readonly staleQueuedTurnsError: typeof staleQueuedTurnsError
  readonly queuedTurnPromoteMaxAgeMs: number
  readonly operationError: (message: string) => Effect.Effect<never, OperationError>
  readonly unavailable: (input: Input, message: string) => OperationUnavailable
}
