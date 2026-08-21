import { Context, Effect, Schema } from "effect"
import type { ExecutionRouteSnapshot } from "../execution/contract/execution-route-snapshot"
import type { TurnId } from "../thread/model/turn-record"
import type { AuthorizationAction } from "./authorization"
import {
  type ActorAttribution,
  type AuditEvent,
  type AuditEventId,
  type AuthenticatedClient,
  type AuthenticatedDevice,
  type BetterAuthMemberId,
  type BetterAuthUserId,
  type AssignmentLeaseEpoch,
  type ClientId,
  type CommitCursor,
  type CommandId,
  type CredentialReference,
  type CredentialReferenceId,
  type CredentialReferenceMetadata,
  type DeviceId,
  type EventId,
  type ExecutorAssignmentId,
  type ExecutorKind,
  type FencingGeneration,
  type GrantRole,
  type HostedThread,
  type HostedOwner,
  type HostedOwnerRecord,
  type HostedWorkspace,
  type IdempotencyKey,
  type JsonObject,
  type LeaseId,
  type LocalWorkspaceBinding,
  type OwnerId,
  type Presence,
  type PresenceStatus,
  type Project,
  type ProjectGrant,
  type ProjectId,
  type ResumableCursor,
  type Sequence,
  type TerminalWriterLease,
  type ThreadCommand,
  type ThreadEvent,
  type ThreadGrant,
  type ThreadId,
  type Timestamp,
  type WorkspaceBindingId,
  type WorkspaceId,
} from "./model"

export const StoreFailureReason = Schema.Literals([
  "not-found",
  "conflict",
  "stale-version",
  "invalid-authority",
  "lease-unavailable",
  "stale-fence",
  "database",
])
export type StoreFailureReason = typeof StoreFailureReason.Type

export class StoreError extends Schema.TaggedError<StoreError>()("HostedStoreError", {
  reason: StoreFailureReason,
  message: Schema.String,
}) {}

export interface CreateProjectInput {
  readonly id: ProjectId
  readonly ownerId: OwnerId
  readonly name: string
  readonly createdByUserId: BetterAuthUserId
  readonly now: Timestamp
}

export interface PutOwnerInput {
  readonly id: OwnerId
  readonly identity: HostedOwner
  readonly now: Timestamp
}

export interface PutProjectGrantInput {
  readonly ownerId: OwnerId
  readonly projectId: ProjectId
  readonly membershipId: BetterAuthMemberId
  readonly role: GrantRole
  readonly grantedByUserId: BetterAuthUserId
  readonly now: Timestamp
}

export interface CreateWorkspaceInput {
  readonly id: WorkspaceId
  readonly ownerId: OwnerId
  readonly projectId?: ProjectId
  readonly createdByUserId: BetterAuthUserId
  readonly executorKind: ExecutorKind
  readonly inheritProjectGrants?: boolean
  readonly now: Timestamp
}

export interface CreateThreadInput {
  readonly id: ThreadId
  readonly ownerId: OwnerId
  readonly projectId?: ProjectId
  readonly workspaceId: WorkspaceId
  readonly createdByUserId: BetterAuthUserId
  readonly executorKind: ExecutorKind
  readonly inheritProjectGrants?: boolean
  readonly now: Timestamp
}

export interface PutThreadGrantInput {
  readonly ownerId: OwnerId
  readonly threadId: ThreadId
  readonly membershipId: BetterAuthMemberId
  readonly role: GrantRole
  readonly grantedByUserId: BetterAuthUserId
  readonly now: Timestamp
}

export interface RegisterDeviceInput {
  readonly id: DeviceId
  readonly userId: BetterAuthUserId
  readonly displayName: string
  readonly publicKeyFingerprint: string
  readonly now: Timestamp
}

export interface AuthenticateClientInput {
  readonly id: ClientId
  readonly userId: BetterAuthUserId
  readonly deviceId: DeviceId
  readonly now: Timestamp
  readonly expiresAt: Timestamp
}

export interface ValidateClientInput {
  readonly userId: BetterAuthUserId
  readonly clientId: ClientId
  readonly deviceId: DeviceId
  readonly at: Timestamp
}

export interface GrantClientAuthorityInput {
  readonly ownerId: OwnerId
  readonly actor: ActorAttribution
  readonly now: Timestamp
  readonly expiresAt: Timestamp
}

export interface AdmitCommandInput {
  readonly ownerId: OwnerId
  readonly threadId: ThreadId
  readonly commandId: CommandId
  readonly idempotencyKey: IdempotencyKey
  readonly actor: ActorAttribution
  readonly command:
    | { readonly _tag: "SubmitPrompt"; readonly prompt: string; readonly mode?: string }
    | { readonly _tag: "Steer"; readonly text: string }
    | { readonly _tag: "Cancel" }
    | {
        readonly _tag: "TerminalInput"
        readonly data: string
        readonly writerLeaseId: LeaseId
        readonly writerGeneration: FencingGeneration
      }
  readonly admittedAt: Timestamp
}

export interface AdmitPromptInput {
  readonly ownerId: OwnerId
  readonly threadId: ThreadId
  readonly commandId: CommandId
  readonly idempotencyKey: IdempotencyKey
  readonly turnId: TurnId
  readonly actor: ActorAttribution
  readonly prompt: string
  readonly executionRoute: ExecutionRouteSnapshot
  readonly admittedAt: Timestamp
  readonly queueCapacity: number
}

export interface AdmittedPrompt {
  readonly command: ThreadCommand
  readonly turnId: TurnId
}

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
  /** The executor that owned the dispatch before its lease was fenced. */
  readonly executorInstanceId: string
  /** The process incarnation that owned the dispatch before its lease was fenced. */
  readonly processIncarnation: string
}

export interface ThreadCursorInput {
  readonly ownerId: OwnerId
  readonly threadId: ThreadId
  readonly actor: ActorAttribution
}

export interface AuthorizeThreadInput extends ThreadCursorInput {
  readonly action: AuthorizationAction
  readonly at?: Timestamp
}

export interface ReadThreadLogInput extends ThreadCursorInput {
  readonly afterCommitCursor: CommitCursor
  readonly limit: number
}

export interface AcknowledgeCursorInput extends ThreadCursorInput {
  readonly commitCursor: CommitCursor
  readonly now: Timestamp
}

export interface AcquireTerminalWriterInput extends ThreadCursorInput {
  readonly leaseId: LeaseId
  readonly now: Timestamp
  readonly expiresAt: Timestamp
}

export interface RenewTerminalWriterInput extends ThreadCursorInput {
  readonly leaseId: LeaseId
  readonly generation: FencingGeneration
  readonly now: Timestamp
  readonly expiresAt: Timestamp
}

export interface UpsertPresenceInput extends ThreadCursorInput {
  readonly status: PresenceStatus
  readonly now: Timestamp
  readonly expiresAt: Timestamp
}

export interface BindLocalWorkspaceInput {
  readonly id: WorkspaceBindingId
  readonly ownerId: OwnerId
  readonly threadId: ThreadId
  readonly userId: BetterAuthUserId
  readonly deviceId: DeviceId
  readonly rootPath: string
  readonly workspaceFingerprint: string
  readonly now: Timestamp
}

export interface RecordAuditEventInput {
  readonly id: AuditEventId
  readonly ownerId: OwnerId
  readonly actor: ActorAttribution
  readonly action: string
  readonly resourceKind: string
  readonly resourceId: string
  readonly attributes: JsonObject
  readonly occurredAt: Timestamp
}

export interface PutCredentialReferenceInput {
  readonly id: CredentialReferenceId
  readonly ownerId: OwnerId
  readonly projectId?: ProjectId
  readonly provider: string
  readonly purpose: string
  readonly externalReference: string
  readonly metadata: CredentialReferenceMetadata
  readonly createdByUserId: BetterAuthUserId
  readonly now: Timestamp
}

export interface StoreService {
  readonly putOwner: (input: PutOwnerInput) => Effect.Effect<HostedOwnerRecord, StoreError>
  readonly createProject: (input: CreateProjectInput) => Effect.Effect<Project, StoreError>
  readonly putProjectGrant: (input: PutProjectGrantInput) => Effect.Effect<ProjectGrant, StoreError>
  readonly createWorkspace: (input: CreateWorkspaceInput) => Effect.Effect<HostedWorkspace, StoreError>
  readonly createThread: (input: CreateThreadInput) => Effect.Effect<HostedThread, StoreError>
  readonly putThreadGrant: (input: PutThreadGrantInput) => Effect.Effect<ThreadGrant, StoreError>
  readonly registerDevice: (input: RegisterDeviceInput) => Effect.Effect<AuthenticatedDevice, StoreError>
  readonly authenticateClient: (input: AuthenticateClientInput) => Effect.Effect<AuthenticatedClient, StoreError>
  readonly validateClient: (input: ValidateClientInput) => Effect.Effect<void, StoreError>
  readonly grantClientAuthority: (input: GrantClientAuthorityInput) => Effect.Effect<void, StoreError>
  readonly authorizeThread: (input: AuthorizeThreadInput) => Effect.Effect<void, StoreError>
  readonly admitCommand: (input: AdmitCommandInput) => Effect.Effect<ThreadCommand, StoreError>
  readonly admitPrompt: (input: AdmitPromptInput) => Effect.Effect<AdmittedPrompt, StoreError>
  readonly readCommands: (input: ReadThreadLogInput) => Effect.Effect<ReadonlyArray<ThreadCommand>, StoreError>
  readonly appendEvent: (input: AppendEventInput) => Effect.Effect<ThreadEvent, StoreError>
  /** Append a terminal recovery event without requiring the expired dispatch lease. */
  readonly appendRecoveredEvent: (input: AppendRecoveredEventInput) => Effect.Effect<ThreadEvent, StoreError>
  readonly readEvents: (input: ReadThreadLogInput) => Effect.Effect<ReadonlyArray<ThreadEvent>, StoreError>
  readonly acknowledgeCursor: (input: AcknowledgeCursorInput) => Effect.Effect<ResumableCursor, StoreError>
  readonly acquireTerminalWriter: (input: AcquireTerminalWriterInput) => Effect.Effect<TerminalWriterLease, StoreError>
  readonly renewTerminalWriter: (input: RenewTerminalWriterInput) => Effect.Effect<TerminalWriterLease, StoreError>
  readonly upsertPresence: (input: UpsertPresenceInput) => Effect.Effect<Presence, StoreError>
  readonly listPresence: (
    input: ThreadCursorInput & { readonly now: Timestamp },
  ) => Effect.Effect<ReadonlyArray<Presence>, StoreError>
  readonly bindLocalWorkspace: (input: BindLocalWorkspaceInput) => Effect.Effect<LocalWorkspaceBinding, StoreError>
  readonly recordAuditEvent: (input: RecordAuditEventInput) => Effect.Effect<AuditEvent, StoreError>
  readonly putCredentialReference: (
    input: PutCredentialReferenceInput,
  ) => Effect.Effect<CredentialReference, StoreError>
}

export class HostedStore extends Context.Service<HostedStore, StoreService>()(
  "@rika/product/hosted/hosted-store/HostedStore",
) {}
