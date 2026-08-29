import { Context, Effect } from "effect"
import type { PromptPart } from "../../execution/request"
import type { ExecutionRouteSnapshot } from "../../execution/route/snapshot"
import type { TurnId } from "../../thread/turn/record"
import type { PromptAdmissionStatus } from "./client"
import type {
  ActorAttribution,
  AssignmentLeaseEpoch,
  CommandId,
  EventId,
  ExecutorAssignmentId,
  FencingGeneration,
  IdempotencyKey,
  JsonObject,
  OwnerId,
  Sequence,
  ThreadCommand,
  ThreadEvent,
  ThreadId,
  Timestamp,
} from "../model"
import type { HostedPersistenceError } from "../persistence-error"

export interface AdmitPromptInput {
  readonly ownerId: OwnerId
  readonly threadId: ThreadId
  readonly commandId: CommandId
  readonly idempotencyKey: IdempotencyKey
  readonly turnId: TurnId
  readonly actor: ActorAttribution
  readonly prompt: string
  readonly promptParts?: ReadonlyArray<PromptPart>
  readonly executionRoute: ExecutionRouteSnapshot
  readonly admittedAt: Timestamp
  readonly queueCapacity: number
  readonly readinessProof: boolean
}

export interface AdmittedPrompt {
  readonly _tag: "Admitted"
  readonly command: ThreadCommand
  readonly turnId: TurnId
  readonly status: PromptAdmissionStatus
}

export interface CancelledPrompt {
  readonly _tag: "Cancelled"
  readonly targetCommandId: CommandId
}

export interface CancelPromptInput {
  readonly ownerId: OwnerId
  readonly threadId: ThreadId
  readonly cancelCommandId: CommandId
  readonly targetCommandId: CommandId
  readonly actor: ActorAttribution
  readonly cancelledAt: Timestamp
}

export type PromptCancellation =
  | { readonly _tag: "Pending"; readonly targetCommandId: CommandId }
  | { readonly _tag: "Turn"; readonly targetCommandId: CommandId; readonly turnId: TurnId }

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

export interface HostedCommandLedgerService {
  readonly admitPrompt: (
    input: AdmitPromptInput,
  ) => Effect.Effect<AdmittedPrompt | CancelledPrompt, HostedPersistenceError>
  readonly cancelPrompt: (input: CancelPromptInput) => Effect.Effect<PromptCancellation, HostedPersistenceError>
  readonly appendEvent: (input: AppendEventInput) => Effect.Effect<ThreadEvent, HostedPersistenceError>
  readonly appendRecoveredEvent: (
    input: AppendRecoveredEventInput,
  ) => Effect.Effect<ThreadEvent, HostedPersistenceError>
}

export class HostedCommandLedger extends Context.Service<HostedCommandLedger, HostedCommandLedgerService>()(
  "@rika/product/hosted/protocol/command-ledger/HostedCommandLedger",
) {}
