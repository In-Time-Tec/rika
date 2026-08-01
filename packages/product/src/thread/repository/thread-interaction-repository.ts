import type { ExecutionRoutePin } from "@rika/product/execution-route-snapshot"
import { Context, Effect, Schema } from "effect"
import { Thread, ThreadId } from "@rika/product/thread-record"
import { Turn, TurnId } from "@rika/product/turn-record"
import type { ThreadRelationship, RelationshipCursor } from "../model/thread-relationship"
import type { AcceptedThreadTurn, ResultRoute, ResultRouteCursor, RootResult } from "./thread-interaction-result"

export class RepositoryError extends Schema.TaggedErrorClass<RepositoryError>()("ThreadInteractionRepositoryError", {
  message: Schema.String,
}) {}
export class InvocationConflict extends Schema.TaggedErrorClass<InvocationConflict>()("ThreadInvocationConflict", {
  invocationDigest: Schema.String,
}) {}
export class AdmissionRejected extends Schema.TaggedErrorClass<AdmissionRejected>()("ThreadAdmissionRejected", {
  reason: Schema.Literals([
    "source-unavailable",
    "target-unavailable",
    "self",
    "workspace",
    "archived",
    "depth",
    "admission-limit",
    "workspace-active-limit",
  ]),
  message: Schema.String,
}) {}
export class QueueFull extends Schema.TaggedErrorClass<QueueFull>()("ThreadInteractionQueueFull", {
  threadId: ThreadId,
  capacity: Schema.Int,
  count: Schema.Int,
}) {}
export class ResultNotReady extends Schema.TaggedErrorClass<ResultNotReady>()("ThreadResultNotReady", {
  targetTurnId: TurnId,
}) {}

interface Invocation {
  readonly invocationDigest: string
  readonly schemaInputDigest: string
  readonly sourceThreadId: ThreadId
  readonly sourceRootTurnId: TurnId
  readonly now: number
}
interface Limits {
  readonly maximumDepth: number
  readonly maximumAdmissions: number
  readonly maximumWorkspaceActive: number
  readonly queueCapacity: number
}
interface TurnInput {
  readonly turnId: TurnId
  readonly prompt: string
  readonly executionRoute: ExecutionRoutePin
}
interface CreateThreadInput extends Invocation, Limits, TurnInput {
  readonly threadId: ThreadId
  readonly title: string
  readonly resultDelivery: "manual" | "reply"
  readonly threadCreationDepth: number
}
interface AppendThreadMessageInput extends Invocation, Limits, TurnInput {
  readonly targetThreadId: ThreadId
  readonly resultDelivery: "manual" | "reply"
  readonly threadCreationDepth: number
}
interface BindThreadControlInput extends Invocation {
  readonly targetThreadId: ThreadId
}
interface DeliverThreadResultInput {
  readonly targetTurnId: TurnId
  readonly deliveredTurnId: TurnId
  readonly queueCapacity: number
  readonly now: number
}
interface SettleThreadResultInput {
  readonly targetTurnId: TurnId
  readonly result: RootResult
  readonly now: number
}
interface BoundThreadControl {
  readonly targetThreadId: ThreadId
  readonly targetTurnId?: TurnId
  readonly outcome: "bound" | "no-active" | "already-terminal"
  readonly queueRevision?: number
  readonly stoppedTurnIds?: ReadonlyArray<TurnId>
}
interface DeliveredThreadResult {
  readonly targetTurnId: TurnId
  readonly delivery: "delivered" | "source-unavailable"
  readonly deliveredTurnId?: TurnId
}
type Failure = RepositoryError | InvocationConflict | AdmissionRejected | QueueFull
export interface Interface {
  readonly createThread: (input: CreateThreadInput) => Effect.Effect<AcceptedThreadTurn, Failure>
  readonly appendMessage: (input: AppendThreadMessageInput) => Effect.Effect<AcceptedThreadTurn, Failure>
  readonly bindSteer: (
    input: BindThreadControlInput,
  ) => Effect.Effect<BoundThreadControl, RepositoryError | InvocationConflict>
  readonly bindCancel: (
    input: BindThreadControlInput,
  ) => Effect.Effect<BoundThreadControl, RepositoryError | InvocationConflict>
  readonly bindStop: (
    input: BindThreadControlInput,
  ) => Effect.Effect<BoundThreadControl, RepositoryError | InvocationConflict>
  readonly settleResult: (input: SettleThreadResultInput) => Effect.Effect<ResultRoute | undefined, RepositoryError>
  readonly deliverResult: (
    input: DeliverThreadResultInput,
  ) => Effect.Effect<DeliveredThreadResult, RepositoryError | QueueFull | ResultNotReady>
  readonly getStatus: (threadId: ThreadId) => Effect.Effect<Thread | undefined, RepositoryError>
  readonly getMessages: (threadId: ThreadId) => Effect.Effect<ReadonlyArray<Turn>, RepositoryError>
  readonly getResultRoute: (targetTurnId: TurnId) => Effect.Effect<ResultRoute | undefined, RepositoryError>
  readonly getRootResult: (targetTurnId: TurnId) => Effect.Effect<RootResult | undefined, RepositoryError>
  readonly listRelationships: (
    threadId: ThreadId,
    limit?: number,
    before?: RelationshipCursor,
  ) => Effect.Effect<ReadonlyArray<ThreadRelationship>, RepositoryError>
  readonly listUndeliveredResults: (
    limit?: number,
    after?: ResultRouteCursor,
  ) => Effect.Effect<ReadonlyArray<ResultRoute>, RepositoryError>
  readonly listReadyResults: (limit?: number) => Effect.Effect<ReadonlyArray<ResultRoute>, RepositoryError>
}
export class Service extends Context.Service<Service, Interface>()(
  "@rika/product/thread/repository/thread-interaction-repository/Service",
) {}
