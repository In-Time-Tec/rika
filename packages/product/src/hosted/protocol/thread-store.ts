import { Context, Effect } from "effect"
import type { InteractiveEvent } from "../../operation/interactive/event"
import type { HostedThreadSnapshot } from "./client"
import type {
  ActorAttribution,
  BetterAuthUserId,
  ClientId,
  CommandId,
  DeviceId,
  IdempotencyKey,
  JsonObject,
  OwnerId,
  ThreadEventCursor,
  ThreadId,
  ThreadVersion,
  Timestamp,
} from "../model"
import type { StoreError } from "../store"

export interface ThreadProtocolCommand {
  readonly ownerId: OwnerId
  readonly threadId: ThreadId
  readonly commandId: CommandId
  readonly idempotencyKey: IdempotencyKey
  readonly expectedThreadVersion: ThreadVersion
  readonly threadVersion: ThreadVersion
  readonly actor: ActorAttribution
  readonly command: JsonObject
  readonly state: "admitted" | "completed"
  readonly result?: JsonObject
  readonly cursor?: ThreadEventCursor
  readonly admittedAt: Timestamp
  readonly completedAt?: Timestamp
}

export type CommandAdmission =
  | { readonly _tag: "Admitted"; readonly command: ThreadProtocolCommand }
  | { readonly _tag: "Duplicate"; readonly command: ThreadProtocolCommand }

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
}

export interface ThreadSocketTicketBinding {
  readonly ticketId: string
  readonly userId: BetterAuthUserId
  readonly clientId: ClientId
  readonly deviceId: DeviceId
  readonly audience: string
  readonly expiresAt: Timestamp
}

export interface ThreadProtocolStoreService {
  readonly initializeThread: (input: {
    readonly ownerId: OwnerId
    readonly threadId: ThreadId
    readonly actor: ActorAttribution
  }) => Effect.Effect<void, StoreError>
  readonly admitCommand: (input: {
    readonly ownerId: OwnerId
    readonly threadId: ThreadId
    readonly commandId: CommandId
    readonly idempotencyKey: IdempotencyKey
    readonly expectedThreadVersion: ThreadVersion
    readonly actor: ActorAttribution
    readonly command: JsonObject
    readonly admittedAt: Timestamp
  }) => Effect.Effect<CommandAdmission, StoreError>
  readonly completeCommand: (input: {
    readonly ownerId: OwnerId
    readonly threadId: ThreadId
    readonly commandId: CommandId
    readonly result: JsonObject
    readonly events: ReadonlyArray<InteractiveEvent>
    readonly snapshot?: HostedThreadSnapshot
    readonly completedAt: Timestamp
  }) => Effect.Effect<ThreadProtocolCommand, StoreError>
  readonly appendEvents: (input: {
    readonly ownerId: OwnerId
    readonly threadId: ThreadId
    readonly events: ReadonlyArray<InteractiveEvent>
    readonly snapshot: HostedThreadSnapshot
    readonly createdAt: Timestamp
  }) => Effect.Effect<ReadonlyArray<ThreadProtocolEvent>, StoreError>
  readonly saveSnapshot: (input: {
    readonly ownerId: OwnerId
    readonly threadId: ThreadId
    readonly threadVersion: ThreadVersion
    readonly cursor: ThreadEventCursor
    readonly snapshot: HostedThreadSnapshot
    readonly createdAt: Timestamp
  }) => Effect.Effect<void, StoreError>
  readonly replay: (input: {
    readonly ownerId: OwnerId
    readonly threadId: ThreadId
    readonly actor: ActorAttribution
    readonly afterCursor: ThreadEventCursor
    readonly throughCursor?: ThreadEventCursor
    readonly includeSnapshot?: boolean
    readonly limit: number
  }) => Effect.Effect<ThreadReplay, StoreError>
  readonly acknowledgeCursor: (input: {
    readonly ownerId: OwnerId
    readonly threadId: ThreadId
    readonly actor: ActorAttribution
    readonly cursor: ThreadEventCursor
    readonly acknowledgedAt: Timestamp
  }) => Effect.Effect<ThreadEventCursor, StoreError>
  readonly issueTicket: (
    input: ThreadSocketTicketBinding & {
      readonly ticketDigest: string
      readonly issuedAt: Timestamp
    },
  ) => Effect.Effect<void, StoreError>
  readonly redeemTicket: (input: {
    readonly ticketDigest: string
    readonly audience: string
    readonly redeemedAt: Timestamp
  }) => Effect.Effect<ThreadSocketTicketBinding, StoreError>
  readonly revokeTicket: (ticketId: string) => Effect.Effect<void, StoreError>
}

export class ThreadProtocolStore extends Context.Service<ThreadProtocolStore, ThreadProtocolStoreService>()(
  "@rika/product/hosted/protocol/thread-store/ThreadProtocolStore",
) {}
