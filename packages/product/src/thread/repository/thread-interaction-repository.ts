import { Context, Effect } from "effect"
import type { AcceptedThreadTurn, ResultRoute, ResultRouteCursor, RootResult } from "./thread-interaction-result"
import {
  AdmissionRejected,
  InvocationConflict,
  QueueFull,
  RepositoryError,
  ResultNotReady,
} from "./thread-interaction-errors"
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

export { ResultDelivery } from "./thread-interaction-result"
export type { RootResult, ResultRoute, ResultRouteCursor, AcceptedThreadTurn } from "./thread-interaction-result"
export { ReceiptKind } from "./thread-interaction-admission"
export type {
  Invocation,
  CreateThreadInput,
  AppendThreadMessageInput,
  BindThreadControlInput,
} from "./thread-interaction-admission"
export type {
  BoundThreadControl,
  DeliveredThreadResult,
  DeliverThreadResultInput,
  SettleThreadResultInput,
} from "./thread-interaction-delivery"
export {
  RepositoryError,
  InvocationConflict,
  AdmissionRejected,
  QueueFull,
  ResultNotReady,
} from "./thread-interaction-errors"
export { TurnAuthor, TurnLineage } from "../model/thread-relationship"
export type { ThreadRelationship, RelationshipCursor } from "../model/thread-relationship"
