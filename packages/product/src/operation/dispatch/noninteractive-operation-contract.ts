import type * as Thread from "../../thread/model/thread-record"
import type * as Turn from "../../thread/model/turn-record"
import type * as TurnRepository from "../../thread/repository/turn-repository"
import type * as ExecutionIngest from "../../execution/service/execution-ingest"
import type { Input, OperationUnavailable } from "../contract/product-operation"
import type { OperationError } from "../operation-error"
import type { PreparedTurn } from "../interactive/interactive-session-runtime"
import type { ModeId } from "@rika/configuration/behavior-mode"
import type { CreateInput } from "../../thread/repository/turn-repository-contract"
import type { Effect } from "effect"

export type NoninteractiveInput = Extract<Input, { readonly _tag: "Run" | "Review" }>

export type AgentExecutionTurn = Turn.AgentExecutionTurn

export type PreparedExecutionTurn = PreparedTurn

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
  readonly ingest: ExecutionIngest.ExecutionIngest
  readonly executionDependencies: import("../interactive/interactive-session-runtime").InteractiveExecutionContext
  readonly operationError: (message: string) => Effect.Effect<never, OperationError>
  readonly unavailable: (input: Input, message: string) => OperationUnavailable
}
