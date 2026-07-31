import { Context, Effect, Schema } from "effect"
import { Thread, ThreadId } from "@rika/product/thread-record"
import { ExecutionRoutePin, Turn, TurnId } from "@rika/product/turn-record"

export const ReceiptKind = Schema.Literals(["create", "message", "steer", "cancel", "stop"])
export type ReceiptKind = typeof ReceiptKind.Type
export const ResultDelivery = Schema.Literals([
  "awaiting-result",
  "ready",
  "delivered",
  "failed",
  "cancelled",
  "source-unavailable",
])
export type ResultDelivery = typeof ResultDelivery.Type

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

export interface Invocation {
  readonly invocationDigest: string
  readonly schemaInputDigest: string
  readonly sourceThreadId: ThreadId
  readonly sourceRootTurnId: TurnId
  readonly now: number
}
export interface Limits {
  readonly maximumDepth: number
  readonly maximumAdmissions: number
  readonly maximumWorkspaceActive: number
  readonly queueCapacity: number
}
export interface TurnInput {
  readonly turnId: TurnId
  readonly prompt: string
  readonly executionRoute: ExecutionRoutePin
}
export interface CreateThreadInput extends Invocation, Limits, TurnInput {
  readonly threadId: ThreadId
  readonly title: string
  readonly resultDelivery: "manual" | "reply"
  readonly threadCreationDepth: number
}
export interface AppendThreadMessageInput extends Invocation, Limits, TurnInput {
  readonly targetThreadId: ThreadId
  readonly resultDelivery: "manual" | "reply"
  readonly threadCreationDepth: number
}
export interface BindThreadControlInput extends Invocation {
  readonly targetThreadId: ThreadId
}
export interface DeliverThreadResultInput {
  readonly targetTurnId: TurnId
  readonly deliveredTurnId: TurnId
  readonly queueCapacity: number
  readonly now: number
}
export interface SettleThreadResultInput {
  readonly targetTurnId: TurnId
  readonly result: RootResult
  readonly now: number
}
export interface AcceptedThreadTurn {
  readonly threadId: ThreadId
  readonly turnId: TurnId
  readonly status: "accepted" | "queued"
  readonly queueRevision?: number
}
export interface BoundThreadControl {
  readonly targetThreadId: ThreadId
  readonly targetTurnId?: TurnId
  readonly outcome: "bound" | "no-active" | "already-terminal"
  readonly queueRevision?: number
  readonly stoppedTurnIds?: ReadonlyArray<TurnId>
}
export interface DeliveredThreadResult {
  readonly targetTurnId: TurnId
  readonly delivery: "delivered" | "source-unavailable"
  readonly deliveredTurnId?: TurnId
}
export type RootResult =
  | { readonly status: "completed"; readonly cursor: string; readonly sequence: number; readonly output: string }
  | { readonly status: "failed"; readonly cursor: string; readonly sequence: number; readonly reason?: string }
  | ((
      | { readonly cursor: string; readonly sequence: number }
      | { readonly cursor?: never; readonly sequence?: never }
    ) & { readonly status: "cancelled"; readonly reason?: string })
interface ResultRouteBase {
  readonly targetTurnId: TurnId
  readonly kind: "manual" | "reply"
  readonly sourceThreadId?: ThreadId
  readonly sourceTurnId?: TurnId
  readonly createdAt: number
  readonly updatedAt: number
}
export type ResultRoute =
  | (ResultRouteBase & { readonly delivery: "awaiting-result" | "failed" | "cancelled" })
  | (ResultRouteBase & { readonly delivery: "ready"; readonly readySequence: number })
  | (ResultRouteBase & {
      readonly delivery: "delivered" | "source-unavailable"
      readonly readySequence: number
      readonly deliveredTurnId?: TurnId
    })
export interface ThreadRelationship {
  readonly kind: "created" | "message" | "reply" | "fork"
  readonly sourceThreadId: ThreadId
  readonly sourceTurnId: TurnId
  readonly targetThreadId: ThreadId
  readonly targetTurnId: TurnId
  readonly createdAt: number
}
export interface RelationshipCursor {
  readonly createdAt: number
  readonly targetTurnId: TurnId
}
export interface ResultRouteCursor {
  readonly targetTurnId: TurnId
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
  "@rika/product/thread-interaction-repository/Service",
) {}
