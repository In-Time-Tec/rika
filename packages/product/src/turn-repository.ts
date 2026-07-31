import { Context, Effect, Schema } from "effect"
import { ThreadId } from "@rika/product/thread-record"
import * as ExecutionStatus from "@rika/product/execution-status"
import {
  AgentExecutionTurn,
  ExecutionExtensionPin,
  ExecutionRoutePin,
  PromptPart,
  RecordedShellTurn,
  Status,
  StopIntent,
  Turn,
  TurnAuthor,
  TurnId,
  TurnLineage,
  isAgentExecution,
  isRunningRecordedShell,
} from "@rika/product/turn-record"
import type { RunningRecordedShellTurn } from "@rika/product/turn-record"

export class RepositoryError extends Schema.TaggedErrorClass<RepositoryError>()("TurnRepositoryError", {
  message: Schema.String,
}) {}

export class QueueFull extends Schema.TaggedErrorClass<QueueFull>()("TurnQueueFull", {
  threadId: ThreadId,
  capacity: Schema.Int,
  count: Schema.Int,
}) {}

export class QueuedTurnUnavailable extends Schema.TaggedErrorClass<QueuedTurnUnavailable>()("QueuedTurnUnavailable", {
  turnId: TurnId,
  message: Schema.String,
}) {}

export interface CreateInput {
  readonly id: TurnId
  readonly threadId: ThreadId
  readonly prompt: string
  readonly promptParts?: ReadonlyArray<PromptPart>
  readonly executionRoute: ExecutionRoutePin
  readonly reviewFanOutId?: string
  readonly author?: TurnAuthor
  readonly lineage?: TurnLineage
  readonly queueCapacity: number
  readonly now: number
}

export const PageCursor = Schema.Struct({ createdAt: Schema.Finite, id: TurnId })
export interface PageCursor extends Schema.Schema.Type<typeof PageCursor> {}

export interface PageOptions {
  readonly before?: PageCursor | undefined
  readonly limit?: number
}

export interface PageResult {
  readonly turns: ReadonlyArray<Turn>
  readonly hasOlder: boolean
  readonly oldestCursor: PageCursor | undefined
  readonly newestCursor: PageCursor | undefined
}

export interface QueueItemChange {
  readonly threadId: ThreadId
  readonly revision: number
  readonly queuedCount: number
  readonly becameNonempty: boolean
  readonly change:
    | { readonly _tag: "Added"; readonly turn: AgentExecutionTurn }
    | { readonly _tag: "Updated"; readonly turn: AgentExecutionTurn }
    | { readonly _tag: "Removed"; readonly turnId: TurnId }
}

export interface QueueSnapshot {
  readonly threadId: ThreadId
  readonly revision: number
  readonly queuedCount: number
  readonly turns: ReadonlyArray<AgentExecutionTurn>
}

export type Submission = AgentExecutionTurn & { readonly queue?: QueueItemChange }

export interface QueueClaim {
  readonly turn: AgentExecutionTurn
  readonly token: string
}

export type QueueClaimFinish =
  | { readonly _tag: "Transitioned"; readonly turn: AgentExecutionTurn; readonly queue: QueueItemChange }
  | { readonly _tag: "Unavailable" }

export interface QueuedTurnTake {
  readonly turn: AgentExecutionTurn
  readonly queue: QueueItemChange
}

export interface QueueWake {
  readonly threadId: ThreadId
  readonly generation: number
  readonly queueRevision: number
}

export const defaultPageSize = 50
export const maximumPageSize = 200

export interface Interface {
  readonly createForSubmission: (input: CreateInput) => Effect.Effect<Submission, RepositoryError | QueueFull>
  readonly copy: (
    turn: AgentExecutionTurn,
    queueCapacity: number,
  ) => Effect.Effect<Submission, RepositoryError | QueueFull>
  readonly get: (id: TurnId) => Effect.Effect<Turn | undefined, RepositoryError>
  readonly list: (threadId: ThreadId) => Effect.Effect<ReadonlyArray<Turn>, RepositoryError>
  readonly listRecentNonqueued: (
    threadId: ThreadId,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<Turn>, RepositoryError>
  readonly page: (threadId: ThreadId, options?: PageOptions) => Effect.Effect<PageResult, RepositoryError>
  readonly findActive: (threadId: ThreadId) => Effect.Effect<AgentExecutionTurn | undefined, RepositoryError>
  readonly readQueue: (threadId: ThreadId) => Effect.Effect<QueueSnapshot, RepositoryError>
  readonly listNonterminal: Effect.Effect<ReadonlyArray<AgentExecutionTurn>, RepositoryError>
  readonly listStopRequested: Effect.Effect<ReadonlyArray<AgentExecutionTurn>, RepositoryError>
  readonly requestStop: (id: TurnId, now: number) => Effect.Effect<AgentExecutionTurn | undefined, RepositoryError>
  readonly claimNextQueued: (threadId: ThreadId, now: number) => Effect.Effect<QueueClaim | undefined, RepositoryError>
  readonly finishQueuedClaim: (
    claim: QueueClaim,
    status: "running" | "failed",
    lastCursor: string | undefined,
    extensionPin: ExecutionExtensionPin | undefined,
    now: number,
  ) => Effect.Effect<QueueClaimFinish, RepositoryError>
  readonly releaseQueuedClaim: (claim: QueueClaim) => Effect.Effect<void, RepositoryError>
  readonly resetQueueClaims: Effect.Effect<void, RepositoryError>
  readonly editQueued: (
    id: TurnId,
    prompt: string,
    now: number,
  ) => Effect.Effect<AgentExecutionTurn & { readonly queue: QueueItemChange }, RepositoryError>
  readonly takeQueued: (id: TurnId) => Effect.Effect<QueuedTurnTake, RepositoryError | QueuedTurnUnavailable>
  readonly dequeue: (id: TurnId) => Effect.Effect<QueueItemChange, RepositoryError>
  readonly requeueAccepted: (
    id: TurnId,
    queueCapacity: number,
    now: number,
  ) => Effect.Effect<AgentExecutionTurn & { readonly queue: QueueItemChange }, RepositoryError | QueueFull>
  readonly requestQueueWake: (threadId: ThreadId) => Effect.Effect<QueueWake | undefined, RepositoryError>
  readonly consumeQueueWake: (threadId: ThreadId, generation: number) => Effect.Effect<boolean, RepositoryError>
  readonly setExtensionPin: (
    id: TurnId,
    pin: ExecutionExtensionPin,
  ) => Effect.Effect<AgentExecutionTurn, RepositoryError>
  readonly setStatus: (
    id: TurnId,
    status: Status,
    lastCursor: string | undefined,
    now: number,
  ) => Effect.Effect<AgentExecutionTurn, RepositoryError>
  readonly startAccepted: (id: TurnId, now: number) => Effect.Effect<boolean, RepositoryError>
  readonly cancelAccepted: (id: TurnId, now: number) => Effect.Effect<boolean, RepositoryError>
  readonly repairCursor: (
    id: TurnId,
    status: Status,
    expectedCursor: string | undefined,
    cursor: string | undefined,
  ) => Effect.Effect<boolean, RepositoryError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/product/turn-repository/Service") {}
