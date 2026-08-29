import { Context, Effect } from "effect"
import type {
  AssignmentLeaseEpoch,
  EventId,
  ExecutorAssignmentId,
  FencingGeneration,
  IdempotencyKey,
  JsonObject,
  Sequence,
  ThreadEvent,
} from "../model"
import type { HostedPersistenceError } from "../persistence-error"

export interface AppendEventInput {
  readonly eventId: EventId
  readonly idempotencyKey: IdempotencyKey
  readonly assignmentId: ExecutorAssignmentId
  readonly assignmentGeneration: FencingGeneration
  readonly leaseEpoch: AssignmentLeaseEpoch
  readonly commandSequence: Sequence | null
  readonly event: JsonObject
}

export interface AppendRecoveredEventInput extends AppendEventInput {
  readonly executorInstanceId: string
  readonly processIncarnation: string
}

export interface HostedThreadEventStoreService {
  readonly appendEvent: (input: AppendEventInput) => Effect.Effect<ThreadEvent, HostedPersistenceError>
  readonly appendRecoveredEvent: (
    input: AppendRecoveredEventInput,
  ) => Effect.Effect<ThreadEvent, HostedPersistenceError>
}

export class HostedThreadEventStore extends Context.Service<HostedThreadEventStore, HostedThreadEventStoreService>()(
  "@rika/product/hosted/protocol/thread-event-store/HostedThreadEventStore",
) {}
