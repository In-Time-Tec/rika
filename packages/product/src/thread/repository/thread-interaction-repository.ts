import { Context, Effect, Schema } from "effect"
import type { AcceptedThreadTurn, ResultRoute, ResultRouteCursor, RootResult } from "./thread-interaction-result"
import type {
  AppendThreadMessageInput,
  BindThreadControlInput,
  CreateThreadInput,
} from "./thread-interaction-admission"
import type {
  BoundThreadControl,
  DeliveredThreadResult,
  DeliverThreadResultInput,
  SettleThreadResultInput,
} from "./thread-interaction-delivery"
import { Thread, ThreadId } from "../model/thread-record"
import { Turn, TurnId } from "../model/turn-record"
import type { ThreadRelationship, RelationshipCursor } from "../model/thread-relationship"
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

export interface Interface {
  readonly createThread: (
    input: CreateThreadInput,
  ) => Effect.Effect<AcceptedThreadTurn, RepositoryError | InvocationConflict | AdmissionRejected | QueueFull>
  readonly appendMessage: (
    input: AppendThreadMessageInput,
  ) => Effect.Effect<AcceptedThreadTurn, RepositoryError | InvocationConflict | AdmissionRejected | QueueFull>
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
