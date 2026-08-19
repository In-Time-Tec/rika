import { Context, Effect, Schema } from "effect"
import { ThreadId } from "@rika/product/thread-record"
import { AgentExecutionTurn, Turn, TurnId } from "@rika/product/turn-record"
import type { RunningRecordedShellTurn, TerminalRecordedShellTurn } from "@rika/product/thread-result"
import type { CreateInput } from "./turn-repository-contract"
import type { PageOptions, PageResult } from "./turn-repository-pagination"
import type { QueuedSteeringAdmissionPreparation, SteeringAdmission } from "./turn-repository-steering"
import type { QueueClaim, QueueClaimFinish, QueueItemChange, QueueSnapshot, Submission } from "./turn-repository-queue"

export class RepositoryError extends Schema.TaggedError<RepositoryError>()("TurnRepositoryError", {
  message: Schema.String,
}) {}

export class QueueFull extends Schema.TaggedError<QueueFull>()("TurnQueueFull", {
  threadId: ThreadId,
  capacity: Schema.Int,
  count: Schema.Int,
}) {}

export class QueuedTurnUnavailable extends Schema.TaggedError<QueuedTurnUnavailable>()("QueuedTurnUnavailable", {
  turnId: TurnId,
  message: Schema.String,
}) {}

export interface Interface {
  readonly createForSubmission: (input: CreateInput) => Effect.Effect<Submission, RepositoryError | QueueFull>
  readonly copy: (
    turn: AgentExecutionTurn,
    queueCapacity: number,
  ) => Effect.Effect<Submission, RepositoryError | QueueFull>
  readonly createRecordedShell: (
    turn: RunningRecordedShellTurn,
  ) => Effect.Effect<RunningRecordedShellTurn, RepositoryError>
  readonly settleRecordedShell: (
    expected: RunningRecordedShellTurn,
    turn: TerminalRecordedShellTurn,
  ) => Effect.Effect<TerminalRecordedShellTurn | undefined, RepositoryError>
  readonly copyRecordedShell: (
    turn: TerminalRecordedShellTurn,
  ) => Effect.Effect<TerminalRecordedShellTurn, RepositoryError>
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
  readonly prepareExecutionAdmission: (
    input: import("@rika/product/execution-gateway").StartTurn,
    now: number,
  ) => Effect.Effect<import("@rika/product/execution-gateway").StartTurn, RepositoryError>
  readonly listUnlinkedExecutionAdmissions: Effect.Effect<
    ReadonlyArray<import("@rika/product/execution-gateway").StartTurn>,
    RepositoryError
  >
  readonly claimNextQueued: (threadId: ThreadId, now: number) => Effect.Effect<QueueClaim | undefined, RepositoryError>
  readonly finishQueuedClaim: (
    claim: QueueClaim,
    status: "running" | "failed",
    now: number,
  ) => Effect.Effect<QueueClaimFinish, RepositoryError>
  readonly releaseQueuedClaim: (claim: QueueClaim) => Effect.Effect<void, RepositoryError>
  readonly resetQueueClaims: Effect.Effect<void, RepositoryError>
  readonly editQueued: (
    id: TurnId,
    prompt: string,
    now: number,
  ) => Effect.Effect<AgentExecutionTurn & { readonly queue: QueueItemChange }, RepositoryError>
  readonly prepareSteeringAdmission: (
    target: import("@rika/product/execution-gateway").ExecutionLink,
    input: import("@rika/product/execution-gateway").SteeringInput,
    pendingRequestIds: ReadonlyArray<string>,
    now: number,
  ) => Effect.Effect<SteeringAdmission, RepositoryError>
  readonly prepareQueuedSteeringAdmission: (
    source: TurnId,
    target: import("@rika/product/execution-gateway").ExecutionLink,
    input: import("@rika/product/execution-gateway").SteeringInput,
    pendingRequestIds: ReadonlyArray<string>,
    now: number,
  ) => Effect.Effect<QueuedSteeringAdmissionPreparation, RepositoryError | QueuedTurnUnavailable>
  readonly listSteeringAdmissions: Effect.Effect<ReadonlyArray<SteeringAdmission>, RepositoryError>
  readonly acceptSteeringAdmission: (
    requestId: string,
    receipt: import("@rika/product/execution-gateway").SteeringReceipt,
  ) => Effect.Effect<SteeringAdmission, RepositoryError>
  readonly rejectSteeringAdmission: (
    requestId: string,
    failure: import("@rika/product/execution-gateway").SteeringFailure,
  ) => Effect.Effect<SteeringAdmission, RepositoryError>
  readonly completeSteeringAdmission: (
    requestId: string,
    target: import("@rika/product/execution-gateway").ExecutionLink,
    receipt: import("@rika/product/execution-gateway").SteeringReceipt,
  ) => Effect.Effect<import("./turn-repository-queue").QueueItemChange | undefined, RepositoryError>
  readonly completeRejectedSteeringAdmission: (requestId: string) => Effect.Effect<boolean, RepositoryError>
  readonly dequeue: (id: TurnId) => Effect.Effect<QueueItemChange, RepositoryError>
  readonly requeueAccepted: (
    id: TurnId,
    queueCapacity: number,
    now: number,
  ) => Effect.Effect<AgentExecutionTurn & { readonly queue: QueueItemChange }, RepositoryError | QueueFull>
  readonly setStatus: (
    id: TurnId,
    status: import("@rika/product/execution-status").Status,
    now: number,
  ) => Effect.Effect<AgentExecutionTurn, RepositoryError>
  readonly attachExecutionLink: (
    id: TurnId,
    link: import("@rika/product/execution-gateway").ExecutionLink,
    now: number,
  ) => Effect.Effect<AgentExecutionTurn, RepositoryError>
  readonly startAccepted: (id: TurnId, now: number) => Effect.Effect<boolean, RepositoryError>
  readonly cancelAccepted: (id: TurnId, now: number) => Effect.Effect<boolean, RepositoryError>
}

export class Service extends Context.Service<Service, Interface>()(
  "@rika/product/thread/repository/turn-repository/Service",
) {}

export const PageCursor = Schema.Struct({ createdAt: Schema.Finite, id: TurnId })
export const defaultPageSize = 50
export const maximumPageSize = 200
