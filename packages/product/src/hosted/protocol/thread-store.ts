import { Context, Effect } from "effect"
import type { ExecutionLink, PreparedTurn } from "../../execution/gateway/service"
import type { PromptPart } from "../../execution/request"
import type { ExecutionRouteSnapshot } from "../../execution/route/snapshot"
import type { InteractiveEvent } from "../../operation/interactive/event"
import type { HostedThreadSnapshot, PromptAdmissionStatus } from "./client"
import type { TurnId } from "../../thread/turn/record"
import type {
  ActorAttribution,
  BetterAuthUserId,
  ClientId,
  CommitCursor,
  CommandId,
  DeviceId,
  IdempotencyKey,
  JsonObject,
  OwnerId,
  Sequence,
  ThreadEventCursor,
  ThreadId,
  ThreadVersion,
  Timestamp,
} from "../model"
import type { HostedPersistenceError } from "../persistence-error"

export interface ThreadProtocolCommand {
  readonly ownerId: OwnerId
  readonly threadId: ThreadId
  readonly commandId: CommandId
  readonly turnId?: TurnId
  readonly idempotencyKey: IdempotencyKey
  readonly expectedThreadVersion: ThreadVersion
  readonly threadVersion: ThreadVersion
  readonly sequence: Sequence
  readonly commitCursor: CommitCursor
  readonly actor: ActorAttribution
  readonly command: JsonObject
  readonly state: "admitted" | "completed"
  readonly workState?: "turn-activation-pending" | "turn-activation-requested"
  readonly admissionStatus?: PromptAdmissionStatus
  readonly cancelledByCommandId?: CommandId
  readonly result?: JsonObject
  readonly cursor?: ThreadEventCursor
  readonly admittedAt: Timestamp
  readonly completedAt?: Timestamp
}

export type CommandAdmission =
  | { readonly _tag: "Admitted"; readonly command: ThreadProtocolCommand }
  | { readonly _tag: "Duplicate"; readonly command: ThreadProtocolCommand }

export type CommandCompletion =
  | { readonly _tag: "Completed"; readonly command: ThreadProtocolCommand }
  | { readonly _tag: "Duplicate"; readonly command: ThreadProtocolCommand }

export interface ApplyPromptInput {
  readonly ownerId: OwnerId
  readonly threadId: ThreadId
  readonly commandId: CommandId
  readonly claimToken?: string
  readonly turnId: TurnId
  readonly actor: ActorAttribution
  readonly prompt: string
  readonly promptParts?: ReadonlyArray<PromptPart>
  readonly executionRoute: ExecutionRouteSnapshot
  readonly prepared: PreparedTurn
  readonly submissionId: string
  readonly completedAt: Timestamp
  readonly queueCapacity: number
  readonly readinessProof: boolean
}

export type PromptApplication =
  | {
      readonly _tag: "Admitted"
      readonly command: ThreadProtocolCommand
      readonly turnId: TurnId
      readonly status: PromptAdmissionStatus
      readonly link: ExecutionLink
    }
  | { readonly _tag: "Cancelled"; readonly command: ThreadProtocolCommand }

export interface CancelPromptInput {
  readonly ownerId: OwnerId
  readonly threadId: ThreadId
  readonly cancelCommandId: CommandId
  readonly targetCommandId: CommandId
  readonly actor: ActorAttribution
  readonly cancelledAt: Timestamp
  readonly claimToken?: string
}

export type PromptCancellation =
  | { readonly _tag: "Pending"; readonly targetCommandId: CommandId }
  | { readonly _tag: "Turn"; readonly targetCommandId: CommandId; readonly turnId: TurnId }

export interface ThreadProtocolEvent {
  readonly ownerId: OwnerId
  readonly threadId: ThreadId
  readonly sequence: string
  readonly cursor: ThreadEventCursor
  readonly threadVersion: ThreadVersion
  readonly event: InteractiveEvent
  readonly createdAt: Timestamp
}

export interface ThreadProtocolSnapshot {
  readonly ownerId: OwnerId
  readonly threadId: ThreadId
  readonly threadVersion: ThreadVersion
  readonly cursor: ThreadEventCursor
  readonly snapshot: HostedThreadSnapshot
  readonly createdAt: Timestamp
}

export interface ThreadReplay {
  readonly threadVersion: ThreadVersion
  readonly cursor: ThreadEventCursor
  readonly snapshot?: ThreadProtocolSnapshot
  readonly events: ReadonlyArray<ThreadProtocolEvent>
  readonly hasMore: boolean
}

export interface ThreadSocketTicketBinding {
  readonly ticketId: string
  readonly userId: BetterAuthUserId
  readonly clientId: ClientId
  readonly deviceId: DeviceId
  readonly audience: string
  readonly expiresAt: Timestamp
}

/** Read capability only. Never accepted by command, presence, or acknowledgement writes. */
export type ThreadReader = ActorAttribution | { readonly _tag: "BrowserRead"; readonly userId: string }

export interface ThreadProtocolStoreService {
  readonly initializeThread: (input: {
    readonly ownerId: OwnerId
    readonly threadId: ThreadId
    readonly actor: ThreadReader
  }) => Effect.Effect<void, HostedPersistenceError>
  readonly admitCommand: (input: {
    readonly ownerId: OwnerId
    readonly threadId: ThreadId
    readonly commandId: CommandId
    readonly turnId?: TurnId
    readonly idempotencyKey: IdempotencyKey
    readonly expectedThreadVersion: ThreadVersion
    readonly actor: ActorAttribution
    readonly command: JsonObject
    readonly admittedAt: Timestamp
  }) => Effect.Effect<CommandAdmission, HostedPersistenceError>
  readonly admitServerCommand: (input: {
    readonly ownerId: OwnerId
    readonly threadId: ThreadId
    readonly commandId: CommandId
    readonly turnId?: TurnId
    readonly idempotencyKey: IdempotencyKey
    readonly actor: ActorAttribution
    readonly command: JsonObject
    readonly admittedAt: Timestamp
  }) => Effect.Effect<CommandAdmission, HostedPersistenceError>
  readonly applyPrompt: <E, R>(
    input: ApplyPromptInput,
    stage: Effect.Effect<ExecutionLink, E, R>,
  ) => Effect.Effect<PromptApplication, HostedPersistenceError | E, R>
  readonly cancelPrompt: (input: CancelPromptInput) => Effect.Effect<PromptCancellation, HostedPersistenceError>
  readonly claimNextCommand: (input: {
    readonly claimToken: string
    readonly claimMillis: number
  }) => Effect.Effect<ThreadProtocolCommand | undefined, HostedPersistenceError>
  readonly oldestRunnableCommandAt: Effect.Effect<number | undefined, HostedPersistenceError>
  readonly renewCommandClaim: (input: {
    readonly ownerId: OwnerId
    readonly threadId: ThreadId
    readonly commandId: CommandId
    readonly claimToken: string
    readonly claimMillis: number
  }) => Effect.Effect<boolean, HostedPersistenceError>
  readonly releaseCommandClaim: (input: {
    readonly ownerId: OwnerId
    readonly threadId: ThreadId
    readonly commandId: CommandId
    readonly claimToken: string
  }) => Effect.Effect<void, HostedPersistenceError>
  readonly completeCommand: (input: {
    readonly ownerId: OwnerId
    readonly threadId: ThreadId
    readonly commandId: CommandId
    readonly claimToken: string
    readonly result: JsonObject
    readonly events: ReadonlyArray<InteractiveEvent>
    readonly snapshot?: HostedThreadSnapshot
    readonly completedAt: Timestamp
  }) => Effect.Effect<CommandCompletion, HostedPersistenceError>
  readonly appendEvents: (input: {
    readonly ownerId: OwnerId
    readonly threadId: ThreadId
    readonly events: ReadonlyArray<InteractiveEvent>
    readonly snapshot?: HostedThreadSnapshot
    readonly createdAt: Timestamp
  }) => Effect.Effect<ReadonlyArray<ThreadProtocolEvent>, HostedPersistenceError>
  readonly checkpoint: (input: {
    readonly ownerId: OwnerId
    readonly threadId: ThreadId
    readonly threadVersion: ThreadVersion
    readonly cursor: ThreadEventCursor
    readonly snapshot: HostedThreadSnapshot
    readonly createdAt: Timestamp
  }) => Effect.Effect<boolean, HostedPersistenceError>
  readonly saveSnapshot: (input: {
    readonly ownerId: OwnerId
    readonly threadId: ThreadId
    readonly threadVersion: ThreadVersion
    readonly cursor: ThreadEventCursor
    readonly snapshot: HostedThreadSnapshot
    readonly createdAt: Timestamp
  }) => Effect.Effect<void, HostedPersistenceError>
  readonly replay: (input: {
    readonly ownerId: OwnerId
    readonly threadId: ThreadId
    readonly actor: ThreadReader
    readonly afterCursor: ThreadEventCursor
    readonly afterCheckpointCursor?: ThreadEventCursor
    readonly throughCursor?: ThreadEventCursor
    readonly includeSnapshot?: boolean
    readonly limit: number
  }) => Effect.Effect<ThreadReplay, HostedPersistenceError>
  readonly acknowledgeCursor: (input: {
    readonly ownerId: OwnerId
    readonly threadId: ThreadId
    readonly actor: ActorAttribution
    readonly cursor: ThreadEventCursor
    readonly acknowledgedAt: Timestamp
  }) => Effect.Effect<
    {
      readonly acknowledgedCursor: ThreadEventCursor
      readonly headCursor: ThreadEventCursor
      readonly threadVersion: ThreadVersion
    },
    HostedPersistenceError
  >
  readonly issueTicket: (
    input: ThreadSocketTicketBinding & {
      readonly ticketDigest: string
      readonly issuedAt: Timestamp
    },
  ) => Effect.Effect<void, HostedPersistenceError>
  readonly redeemTicket: (input: {
    readonly ticketDigest: string
    readonly audience: string
    readonly redeemedAt: Timestamp
  }) => Effect.Effect<ThreadSocketTicketBinding, HostedPersistenceError>
  readonly revokeTicket: (ticketId: string) => Effect.Effect<void, HostedPersistenceError>
}

export class ThreadProtocolStore extends Context.Service<ThreadProtocolStore, ThreadProtocolStoreService>()(
  "@rika/product/hosted/protocol/thread-store/ThreadProtocolStore",
) {}
