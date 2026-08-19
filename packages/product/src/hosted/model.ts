import { Schema } from "effect"

const OpaqueId = Schema.String.check(
  Schema.isPattern(/^[\x21-\x7e]{1,255}$/),
)
const Decimal = Schema.String.check(Schema.isPattern(/^(0|[1-9][0-9]*)$/))

export const OrganizationId = OpaqueId.pipe(Schema.brand("HostedOrganizationId"))
export type OrganizationId = typeof OrganizationId.Type
export const BetterAuthMemberId = OpaqueId.pipe(Schema.brand("BetterAuthMemberId"))
export type BetterAuthMemberId = typeof BetterAuthMemberId.Type
export const ProjectId = OpaqueId.pipe(Schema.brand("HostedProjectId"))
export type ProjectId = typeof ProjectId.Type
export const WorkspaceId = OpaqueId.pipe(Schema.brand("HostedWorkspaceId"))
export type WorkspaceId = typeof WorkspaceId.Type
export const ThreadId = OpaqueId.pipe(Schema.brand("HostedThreadId"))
export type ThreadId = typeof ThreadId.Type
export const DeviceId = OpaqueId.pipe(Schema.brand("HostedDeviceId"))
export type DeviceId = typeof DeviceId.Type
export const ClientId = OpaqueId.pipe(Schema.brand("HostedClientId"))
export type ClientId = typeof ClientId.Type
export const ExecutorInstanceId = OpaqueId.pipe(Schema.brand("HostedExecutorInstanceId"))
export type ExecutorInstanceId = typeof ExecutorInstanceId.Type
export const ExecutorAssignmentId = OpaqueId.pipe(Schema.brand("HostedExecutorAssignmentId"))
export type ExecutorAssignmentId = typeof ExecutorAssignmentId.Type
export const LeaseId = OpaqueId.pipe(Schema.brand("HostedLeaseId"))
export type LeaseId = typeof LeaseId.Type
export const CommandId = OpaqueId.pipe(Schema.brand("HostedCommandId"))
export type CommandId = typeof CommandId.Type
export const EventId = OpaqueId.pipe(Schema.brand("HostedEventId"))
export type EventId = typeof EventId.Type
export const CheckpointId = OpaqueId.pipe(Schema.brand("HostedCheckpointId"))
export type CheckpointId = typeof CheckpointId.Type
export const WorkspaceBindingId = OpaqueId.pipe(Schema.brand("HostedWorkspaceBindingId"))
export type WorkspaceBindingId = typeof WorkspaceBindingId.Type
export const AuditEventId = OpaqueId.pipe(Schema.brand("HostedAuditEventId"))
export type AuditEventId = typeof AuditEventId.Type
export const CredentialReferenceId = OpaqueId.pipe(Schema.brand("HostedCredentialReferenceId"))
export type CredentialReferenceId = typeof CredentialReferenceId.Type
export const IdempotencyKey = OpaqueId.pipe(Schema.brand("HostedIdempotencyKey"))
export type IdempotencyKey = typeof IdempotencyKey.Type
export const Sequence = Decimal.pipe(Schema.brand("HostedSequence"))
export type Sequence = typeof Sequence.Type
export const CommitCursor = Decimal.pipe(Schema.brand("HostedCommitCursor"))
export type CommitCursor = typeof CommitCursor.Type
export const FencingGeneration = Decimal.pipe(Schema.brand("HostedFencingGeneration"))
export type FencingGeneration = typeof FencingGeneration.Type
export const AssignmentLeaseEpoch = FencingGeneration.pipe(Schema.brand("HostedAssignmentLeaseEpoch"))
export type AssignmentLeaseEpoch = typeof AssignmentLeaseEpoch.Type
export const Timestamp = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/))
export type Timestamp = typeof Timestamp.Type
export const JsonObject = Schema.Record(Schema.String, Schema.Unknown)
export type JsonObject = typeof JsonObject.Type
const SecretMetadataKey =
  /^(api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret|private[_-]?key|authorization|cookie)$/i
const containsSecretMetadataKey = (value: unknown): boolean => {
  if (Array.isArray(value)) return value.some(containsSecretMetadataKey)
  if (typeof value !== "object" || value === null) return false
  return Object.entries(value).some(([key, nested]) => SecretMetadataKey.test(key) || containsSecretMetadataKey(nested))
}
export const CredentialReferenceMetadata = JsonObject.check(
  Schema.makeFilter((metadata) =>
    containsSecretMetadataKey(metadata)
      ? [{ path: [], issue: "credential metadata must not contain secret material" }]
      : [],
  ),
)
export type CredentialReferenceMetadata = typeof CredentialReferenceMetadata.Type

export const ExecutorKind = Schema.Literals(["local_device", "e2b"])
export type ExecutorKind = typeof ExecutorKind.Type
export const GrantRole = Schema.Literals(["viewer", "controller", "operator", "owner"])
export type GrantRole = typeof GrantRole.Type
export const PresenceStatus = Schema.Literals(["viewing", "controlling", "away"])
export type PresenceStatus = typeof PresenceStatus.Type

export const ActorAttribution = Schema.TaggedStruct("AuthenticatedMember", {
  organizationId: OrganizationId,
  memberId: BetterAuthMemberId,
  clientId: ClientId,
  deviceId: DeviceId,
})
export type ActorAttribution = typeof ActorAttribution.Type

export const Project = Schema.Struct({
  id: ProjectId,
  organizationId: OrganizationId,
  name: Schema.NonEmptyString,
  createdByMemberId: BetterAuthMemberId,
  createdAt: Timestamp,
  updatedAt: Timestamp,
})
export type Project = typeof Project.Type

export const HostedWorkspace = Schema.Struct({
  id: WorkspaceId,
  organizationId: OrganizationId,
  projectId: ProjectId,
  createdByMemberId: BetterAuthMemberId,
  executorKind: ExecutorKind,
  inheritProjectGrants: Schema.Boolean,
  createdAt: Timestamp,
})
export type HostedWorkspace = typeof HostedWorkspace.Type

export const ProjectGrant = Schema.Struct({
  organizationId: OrganizationId,
  projectId: ProjectId,
  memberId: BetterAuthMemberId,
  role: GrantRole,
  grantedByMemberId: BetterAuthMemberId,
  createdAt: Timestamp,
  updatedAt: Timestamp,
})
export type ProjectGrant = typeof ProjectGrant.Type

export const HostedThread = Schema.Struct({
  id: ThreadId,
  organizationId: OrganizationId,
  projectId: ProjectId,
  workspaceId: WorkspaceId,
  createdByMemberId: BetterAuthMemberId,
  executorKind: ExecutorKind,
  inheritProjectGrants: Schema.Boolean,
  createdAt: Timestamp,
})
export type HostedThread = typeof HostedThread.Type

export const ThreadGrant = Schema.Struct({
  organizationId: OrganizationId,
  threadId: ThreadId,
  memberId: BetterAuthMemberId,
  role: GrantRole,
  grantedByMemberId: BetterAuthMemberId,
  createdAt: Timestamp,
  updatedAt: Timestamp,
})
export type ThreadGrant = typeof ThreadGrant.Type

export const AuthenticatedDevice = Schema.Struct({
  id: DeviceId,
  organizationId: OrganizationId,
  memberId: BetterAuthMemberId,
  displayName: Schema.NonEmptyString,
  publicKeyFingerprint: Schema.NonEmptyString,
  createdAt: Timestamp,
  lastSeenAt: Timestamp,
  revokedAt: Schema.NullOr(Timestamp),
})
export type AuthenticatedDevice = typeof AuthenticatedDevice.Type

export const AuthenticatedClient = Schema.Struct({
  id: ClientId,
  organizationId: OrganizationId,
  memberId: BetterAuthMemberId,
  deviceId: DeviceId,
  authenticatedAt: Timestamp,
  lastSeenAt: Timestamp,
  expiresAt: Timestamp,
  revokedAt: Schema.NullOr(Timestamp),
})
export type AuthenticatedClient = typeof AuthenticatedClient.Type

export const ThreadCommand = Schema.Struct({
  organizationId: OrganizationId,
  threadId: ThreadId,
  memberId: BetterAuthMemberId,
  clientId: ClientId,
  commandId: CommandId,
  idempotencyKey: IdempotencyKey,
  actor: ActorAttribution,
  sequence: Sequence,
  commitCursor: CommitCursor,
  command: JsonObject,
  admittedAt: Timestamp,
})
export type ThreadCommand = typeof ThreadCommand.Type

export const ThreadEvent = Schema.Struct({
  organizationId: OrganizationId,
  threadId: ThreadId,
  eventId: EventId,
  idempotencyKey: IdempotencyKey,
  assignmentId: ExecutorAssignmentId,
  executorInstanceId: ExecutorInstanceId,
  assignmentGeneration: FencingGeneration,
  leaseEpoch: AssignmentLeaseEpoch,
  sequence: Sequence,
  commitCursor: CommitCursor,
  commandSequence: Schema.NullOr(Sequence),
  event: JsonObject,
  createdAt: Timestamp,
})
export type ThreadEvent = typeof ThreadEvent.Type

export const ResumableCursor = Schema.Struct({
  organizationId: OrganizationId,
  threadId: ThreadId,
  memberId: BetterAuthMemberId,
  clientId: ClientId,
  commitCursor: CommitCursor,
  updatedAt: Timestamp,
})
export type ResumableCursor = typeof ResumableCursor.Type

export const TerminalWriterLease = Schema.Struct({
  organizationId: OrganizationId,
  threadId: ThreadId,
  memberId: BetterAuthMemberId,
  clientId: ClientId,
  leaseId: LeaseId,
  generation: FencingGeneration,
  acquiredAt: Timestamp,
  renewedAt: Timestamp,
  expiresAt: Timestamp,
})
export type TerminalWriterLease = typeof TerminalWriterLease.Type

export const Presence = Schema.Struct({
  organizationId: OrganizationId,
  threadId: ThreadId,
  memberId: BetterAuthMemberId,
  clientId: ClientId,
  status: PresenceStatus,
  lastSeenAt: Timestamp,
  expiresAt: Timestamp,
})
export type Presence = typeof Presence.Type

export const LocalWorkspaceBinding = Schema.Struct({
  id: WorkspaceBindingId,
  organizationId: OrganizationId,
  threadId: ThreadId,
  memberId: BetterAuthMemberId,
  deviceId: DeviceId,
  rootPath: Schema.NonEmptyString,
  workspaceFingerprint: Schema.NonEmptyString,
  createdAt: Timestamp,
  lastSeenAt: Timestamp,
})
export type LocalWorkspaceBinding = typeof LocalWorkspaceBinding.Type

export const AuditEvent = Schema.Struct({
  id: AuditEventId,
  organizationId: OrganizationId,
  actorMemberId: BetterAuthMemberId,
  actorClientId: ClientId,
  action: Schema.NonEmptyString,
  resourceKind: Schema.NonEmptyString,
  resourceId: Schema.NonEmptyString,
  commitCursor: CommitCursor,
  attributes: JsonObject,
  occurredAt: Timestamp,
})
export type AuditEvent = typeof AuditEvent.Type

export const CredentialReference = Schema.Struct({
  id: CredentialReferenceId,
  organizationId: OrganizationId,
  projectId: Schema.NullOr(ProjectId),
  provider: Schema.NonEmptyString,
  purpose: Schema.NonEmptyString,
  externalReference: Schema.NonEmptyString,
  metadata: CredentialReferenceMetadata,
  createdByMemberId: BetterAuthMemberId,
  createdAt: Timestamp,
  updatedAt: Timestamp,
})
export type CredentialReference = typeof CredentialReference.Type
