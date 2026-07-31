import { Effect, Schema } from "effect"
import { ThreadId } from "@rika/product/thread-record"
import * as TurnRepository from "@rika/product/turn-repository"
import { AgentExecutionTurn, RecordedShellTurn, Turn, TurnId, isAgentExecution } from "@rika/product/turn-record"
import type { RunningRecordedShellTurn } from "@rika/product/turn-record"
import {
  QueueFull,
  QueuedTurnUnavailable,
  RepositoryError,
  defaultPageSize,
  maximumPageSize,
} from "@rika/product/turn-repository"
import type { Submission, QueueItemChange, Interface, PageCursor } from "@rika/product/turn-repository"
import * as ExecutionStatus from "@rika/product/execution-status"
export const isTerminalStatus = ExecutionStatus.isTerminalStatus
export const MemoryCoordinatorTypeId = Symbol("@rika/product/turn-repository/MemoryCoordinator")

type TerminalStatus = "completed" | "failed" | "cancelled"
export type MemoryRefoldWrite<A> = { readonly _tag: "Commit"; readonly value: A } | { readonly _tag: "Stale" }
type MemoryRefoldResult<A> =
  | { readonly _tag: "Committed"; readonly turn: AgentExecutionTurn; readonly value: A }
  | { readonly _tag: "Stale" }

export interface MemoryCoordinator {
  readonly withLock: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  readonly agentExecutions: Effect.Effect<ReadonlyArray<AgentExecutionTurn>>
  readonly adoptRefold: <A>(
    expected: Pick<AgentExecutionTurn, "id" | "status" | "lastCursor">,
    status: TerminalStatus,
    cursor: string,
    write: (turn: AgentExecutionTurn) => Effect.Effect<MemoryRefoldWrite<A>>,
  ) => Effect.Effect<MemoryRefoldResult<A>>
  readonly writeRecordedShell: <A>(
    expected: RunningRecordedShellTurn | undefined,
    turn: RecordedShellTurn,
    write: (turn: RecordedShellTurn) => Effect.Effect<MemoryRefoldWrite<A>>,
  ) => Effect.Effect<MemoryRefoldWrite<{ readonly turn: RecordedShellTurn; readonly value: A }>>
}

export const memoryCoordinator = (repository: Interface): MemoryCoordinator | undefined =>
  (repository as Interface & { readonly [MemoryCoordinatorTypeId]?: MemoryCoordinator })[MemoryCoordinatorTypeId]

export const repositoryError = (error: unknown) =>
  Schema.is(RepositoryError)(error) ? error : RepositoryError.make({ message: String(error) })
export const submissionError = (error: unknown) => (Schema.is(QueueFull)(error) ? error : repositoryError(error))
export const takeQueuedError = (error: unknown) =>
  Schema.is(QueuedTurnUnavailable)(error) ? error : repositoryError(error)
export const missing = (id: TurnId) => RepositoryError.make({ message: `Turn ${id} does not exist` })
export const queuedTurnUnavailable = (id: TurnId) =>
  QueuedTurnUnavailable.make({ turnId: id, message: `Turn ${id} is not queued` })
export const clone = <T extends Turn>(turn: T): T => structuredClone(turn)
export const sameTurn = Schema.toEquivalence(Turn)
export const pageSize = (limit: number | undefined) =>
  Math.min(maximumPageSize, Math.max(1, Math.floor(limit ?? defaultPageSize)))
export const cursorFor = (turn: Turn | undefined): PageCursor | undefined =>
  turn === undefined ? undefined : { createdAt: turn.createdAt, id: turn.id }
export interface MemoryQueueState {
  readonly revision: number
  readonly queuedCount: number
  readonly wakeGeneration: number
  readonly wakePending: boolean
}

export interface MemoryState {
  readonly turns: ReadonlyMap<TurnId, Turn>
  readonly queues: ReadonlyMap<ThreadId, MemoryQueueState>
  readonly claims: ReadonlyMap<TurnId, string>
  readonly nextClaimToken: number
}

export type MemorySubmissionResult =
  | { readonly _tag: "Duplicate" }
  | { readonly _tag: "Full"; readonly error: QueueFull }
  | { readonly _tag: "Created"; readonly submission: Submission }

export type MemoryRequeueResult =
  | { readonly _tag: "Unavailable" }
  | { readonly _tag: "Full"; readonly error: QueueFull }
  | { readonly _tag: "Queued"; readonly value: AgentExecutionTurn & { readonly queue: QueueItemChange } }

export const emptyQueueState: MemoryQueueState = {
  revision: 0,
  queuedCount: 0,
  wakeGeneration: 0,
  wakePending: false,
}

export const queueState = (state: MemoryState, threadId: ThreadId): MemoryQueueState =>
  state.queues.get(threadId) ?? emptyQueueState

export const withQueueState = (state: MemoryState, threadId: ThreadId, queue: MemoryQueueState): MemoryState => ({
  ...state,
  queues: new Map(state.queues).set(threadId, queue),
})
