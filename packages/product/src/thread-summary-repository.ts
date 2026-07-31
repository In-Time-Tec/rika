import { Context, Effect, Layer, Schema } from "effect"
import { ExecutionStatus } from "@rika/coding-tools/coding-tool-catalog"
import * as ThreadRepository from "./thread-repository"
import { ThreadId } from "@rika/product/thread-record"
import { EditTotals, RepairCandidate, ThreadSummary } from "@rika/product/thread-summary"
import * as TurnRepository from "./turn-repository"
import { Status, TurnId, isAgentExecution } from "@rika/product/turn-record"
import * as ThreadState from "@rika/product/thread-state"

export class RepositoryError extends Schema.TaggedErrorClass<RepositoryError>()("ThreadSummaryRepositoryError", {
  message: Schema.String,
}) {}

export interface ListInput {
  readonly includeArchived?: boolean
  readonly limit?: number
}

export interface TurnActivityInput {
  readonly turnId: TurnId
  readonly threadId: ThreadId
  readonly projectedCursor?: string
  readonly complete: boolean
  readonly editTotals: EditTotals
  readonly lastEventAt?: number
  readonly now: number
}

export interface Interface {
  readonly list: (input?: ListInput) => Effect.Effect<ReadonlyArray<ThreadSummary>, RepositoryError>
  readonly ensureTurn: (turnId: TurnId, threadId: ThreadId, now: number) => Effect.Effect<void, RepositoryError>
  readonly replaceTurn: (input: TurnActivityInput) => Effect.Effect<void, RepositoryError>
  readonly markRead: (threadId: ThreadId, now: number) => Effect.Effect<void, RepositoryError>
  readonly listRepairCandidates: (limit?: number) => Effect.Effect<ReadonlyArray<RepairCandidate>, RepositoryError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/product/thread-summary-repository/Service") {}

interface Activity {
  readonly turnId: TurnId
  readonly threadId: ThreadId
  readonly projectedCursor?: string
  readonly complete: boolean
  readonly editTotals: EditTotals
  readonly lastEventAt?: number
  readonly updatedAt: number
}

export const memoryLayer = Layer.succeed(
  Service,
  Service.of({
    list: () => Effect.succeed<ReadonlyArray<ThreadSummary>>([]),
    ensureTurn: () => Effect.void,
    replaceTurn: () => Effect.void,
    markRead: () => Effect.void,
    listRepairCandidates: () => Effect.succeed<ReadonlyArray<RepairCandidate>>([]),
  }),
)
