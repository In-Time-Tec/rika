import { Context, Effect, Schema } from "effect"
import type { ClientCommand } from "./protocol/client-control-plane-protocol"
import {
  type ActorAttribution,
  type AuditEvent,
  type AuditEventId,
  type AuthenticatedClient,
  type AuthenticatedDevice,
  type BetterAuthMemberId,
  type Checkpoint,
  type CheckpointId,
  type ClientId,
  type CommitCursor,
  type CommandId,
  type CredentialReference,
  type CredentialReferenceId,
  type CredentialReferenceMetadata,
  type DeviceId,
  type EventId,
  type ExecutorAssignmentLease,
  type ExecutorInstance,
  type ExecutorInstanceId,
  type ExecutorKind,
  type FencingGeneration,
  type GrantRole,
  type HostedThread,
  type HostedWorkspace,
  type IdempotencyKey,
  type JsonObject,
  type LeaseId,
  type LocalWorkspaceBinding,
  type OrganizationId,
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
} from "./hosted-authority-model"

export const HostedRepositoryFailureReason = Schema.Literals([
  "not-found",
  "conflict",
  "invalid-authority",
  "lease-unavailable",
  "stale-fence",
  "database",
])
export type HostedRepositoryFailureReason = typeof HostedRepositoryFailureReason.Type

export class HostedRepositoryError extends Schema.TaggedError<HostedRepositoryError>()("HostedRepositoryError", {
  reason: HostedRepositoryFailureReason,
  message: Schema.String,
}) {}

export interface CreateProjectInput {
  readonly id: ProjectId
  readonly organizationId: OrganizationId
  readonly name: string
  readonly createdByMemberId: BetterAuthMemberId
  readonly now: Timestamp
}

export interface PutProjectGrantInput {
  readonly organizationId: OrganizationId
  readonly projectId: ProjectId
  readonly memberId: BetterAuthMemberId
  readonly role: GrantRole
  readonly grantedByMemberId: BetterAuthMemberId
  readonly now: Timestamp
}

export interface CreateWorkspaceInput {
  readonly id: WorkspaceId
  readonly organizationId: OrganizationId
  readonly projectId: ProjectId
  readonly createdByMemberId: BetterAuthMemberId
  readonly executorKind: ExecutorKind
  readonly inheritProjectGrants?: boolean
  readonly now: Timestamp
}

export interface CreateThreadInput {
  readonly id: ThreadId
  readonly organizationId: OrganizationId
  readonly projectId: ProjectId
  readonly workspaceId: WorkspaceId
  readonly createdByMemberId: BetterAuthMemberId
  readonly executorKind: ExecutorKind
  readonly inheritProjectGrants?: boolean
  readonly now: Timestamp
}

export interface PutThreadGrantInput {
  readonly organizationId: OrganizationId
  readonly threadId: ThreadId
  readonly memberId: BetterAuthMemberId
  readonly role: GrantRole
  readonly grantedByMemberId: BetterAuthMemberId
  readonly now: Timestamp
}

export interface RegisterDeviceInput {
  readonly id: DeviceId
  readonly organizationId: OrganizationId
  readonly memberId: BetterAuthMemberId
  readonly displayName: string
  readonly publicKeyFingerprint: string
  readonly now: Timestamp
}

export interface AuthenticateClientInput {
  readonly id: ClientId
  readonly organizationId: OrganizationId
  readonly memberId: BetterAuthMemberId
  readonly deviceId: DeviceId
  readonly now: Timestamp
  readonly expiresAt: Timestamp
}

export interface RegisterExecutorInput {
  readonly id: ExecutorInstanceId
  readonly organizationId: OrganizationId
  readonly executorKind: ExecutorKind
  readonly deviceId: DeviceId | null
  readonly now: Timestamp
}

export interface AcquireAssignmentInput {
  readonly organizationId: OrganizationId
  readonly threadId: ThreadId
  readonly executorInstanceId: ExecutorInstanceId
  readonly executorKind: ExecutorKind
  readonly leaseId: LeaseId
  readonly now: Timestamp
  readonly expiresAt: Timestamp
}

export interface RenewAssignmentInput {
  readonly organizationId: OrganizationId
  readonly threadId: ThreadId
  readonly executorInstanceId: ExecutorInstanceId
  readonly leaseId: LeaseId
  readonly generation: FencingGeneration
  readonly now: Timestamp
  readonly expiresAt: Timestamp
}

export interface AdmitCommandInput {
  readonly organizationId: OrganizationId
  readonly threadId: ThreadId
  readonly memberId: BetterAuthMemberId
  readonly clientId: ClientId
  readonly commandId: CommandId
  readonly idempotencyKey: IdempotencyKey
  readonly actor: ActorAttribution
  readonly command: ClientCommand
  readonly admittedAt: Timestamp
}

export interface AppendEventInput {
  readonly organizationId: OrganizationId
  readonly threadId: ThreadId
  readonly eventId: EventId
  readonly idempotencyKey: IdempotencyKey
  readonly executorInstanceId: ExecutorInstanceId
  readonly leaseId: LeaseId
  readonly assignmentGeneration: FencingGeneration
  readonly commandSequence: Sequence | null
  readonly event: JsonObject
  readonly createdAt: Timestamp
}

export interface ThreadCursorInput {
  readonly organizationId: OrganizationId
  readonly threadId: ThreadId
  readonly memberId: BetterAuthMemberId
  readonly clientId: ClientId
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
  readonly organizationId: OrganizationId
  readonly threadId: ThreadId
  readonly memberId: BetterAuthMemberId
  readonly deviceId: DeviceId
  readonly rootPath: string
  readonly workspaceFingerprint: string
  readonly now: Timestamp
}

export interface SaveCheckpointInput {
  readonly id: CheckpointId
  readonly organizationId: OrganizationId
  readonly threadId: ThreadId
  readonly executorInstanceId: ExecutorInstanceId
  readonly leaseId: LeaseId
  readonly assignmentGeneration: FencingGeneration
  readonly eventSequence: Sequence
  readonly batonCheckpointReference: string
  readonly metadata: JsonObject
  readonly createdAt: Timestamp
}

export interface RecordAuditEventInput {
  readonly id: AuditEventId
  readonly organizationId: OrganizationId
  readonly actorMemberId: BetterAuthMemberId
  readonly actorClientId: ClientId
  readonly action: string
  readonly resourceKind: string
  readonly resourceId: string
  readonly attributes: JsonObject
  readonly occurredAt: Timestamp
}

export interface PutCredentialReferenceInput {
  readonly id: CredentialReferenceId
  readonly organizationId: OrganizationId
  readonly projectId: ProjectId | null
  readonly provider: string
  readonly purpose: string
  readonly externalReference: string
  readonly metadata: CredentialReferenceMetadata
  readonly createdByMemberId: BetterAuthMemberId
  readonly now: Timestamp
}

export interface HostedRepositoryInterface {
  readonly createProject: (input: CreateProjectInput) => Effect.Effect<Project, HostedRepositoryError>
  readonly putProjectGrant: (input: PutProjectGrantInput) => Effect.Effect<ProjectGrant, HostedRepositoryError>
  readonly createWorkspace: (input: CreateWorkspaceInput) => Effect.Effect<HostedWorkspace, HostedRepositoryError>
  readonly createThread: (input: CreateThreadInput) => Effect.Effect<HostedThread, HostedRepositoryError>
  readonly putThreadGrant: (input: PutThreadGrantInput) => Effect.Effect<ThreadGrant, HostedRepositoryError>
  readonly registerDevice: (input: RegisterDeviceInput) => Effect.Effect<AuthenticatedDevice, HostedRepositoryError>
  readonly authenticateClient: (
    input: AuthenticateClientInput,
  ) => Effect.Effect<AuthenticatedClient, HostedRepositoryError>
  readonly registerExecutor: (input: RegisterExecutorInput) => Effect.Effect<ExecutorInstance, HostedRepositoryError>
  readonly acquireAssignment: (
    input: AcquireAssignmentInput,
  ) => Effect.Effect<ExecutorAssignmentLease, HostedRepositoryError>
  readonly renewAssignment: (
    input: RenewAssignmentInput,
  ) => Effect.Effect<ExecutorAssignmentLease, HostedRepositoryError>
  readonly admitCommand: (input: AdmitCommandInput) => Effect.Effect<ThreadCommand, HostedRepositoryError>
  readonly readCommands: (
    input: ReadThreadLogInput,
  ) => Effect.Effect<ReadonlyArray<ThreadCommand>, HostedRepositoryError>
  readonly appendEvent: (input: AppendEventInput) => Effect.Effect<ThreadEvent, HostedRepositoryError>
  readonly readEvents: (input: ReadThreadLogInput) => Effect.Effect<ReadonlyArray<ThreadEvent>, HostedRepositoryError>
  readonly acknowledgeCursor: (input: AcknowledgeCursorInput) => Effect.Effect<ResumableCursor, HostedRepositoryError>
  readonly acquireTerminalWriter: (
    input: AcquireTerminalWriterInput,
  ) => Effect.Effect<TerminalWriterLease, HostedRepositoryError>
  readonly renewTerminalWriter: (
    input: RenewTerminalWriterInput,
  ) => Effect.Effect<TerminalWriterLease, HostedRepositoryError>
  readonly upsertPresence: (input: UpsertPresenceInput) => Effect.Effect<Presence, HostedRepositoryError>
  readonly listPresence: (
    input: ThreadCursorInput & { readonly now: Timestamp },
  ) => Effect.Effect<ReadonlyArray<Presence>, HostedRepositoryError>
  readonly bindLocalWorkspace: (
    input: BindLocalWorkspaceInput,
  ) => Effect.Effect<LocalWorkspaceBinding, HostedRepositoryError>
  readonly saveCheckpoint: (input: SaveCheckpointInput) => Effect.Effect<Checkpoint, HostedRepositoryError>
  readonly recordAuditEvent: (input: RecordAuditEventInput) => Effect.Effect<AuditEvent, HostedRepositoryError>
  readonly putCredentialReference: (
    input: PutCredentialReferenceInput,
  ) => Effect.Effect<CredentialReference, HostedRepositoryError>
}

export class HostedRepository extends Context.Service<HostedRepository, HostedRepositoryInterface>()(
  "@rika/product/hosted/hosted-authority-repository/HostedRepository",
) {}
