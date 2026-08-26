import { Schema } from "effect"

const OpaqueId = Schema.String.check(Schema.isPattern(/^[\x21-\x7e]{1,255}$/))
const Decimal = Schema.String.check(Schema.isPattern(/^(0|[1-9][0-9]*)$/))

export const OrganizationId = OpaqueId.pipe(Schema.brand("HostedOrganizationId"))
export type OrganizationId = typeof OrganizationId.Type
export const OwnerId = OpaqueId.pipe(Schema.brand("HostedOwnerId"))
export type OwnerId = typeof OwnerId.Type
export const BetterAuthUserId = OpaqueId.pipe(Schema.brand("BetterAuthUserId"))
export type BetterAuthUserId = typeof BetterAuthUserId.Type
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
export const AuditEventId = OpaqueId.pipe(Schema.brand("HostedAuditEventId"))
export type AuditEventId = typeof AuditEventId.Type
export const CredentialReferenceId = OpaqueId.pipe(Schema.brand("HostedCredentialReferenceId"))
export type CredentialReferenceId = typeof CredentialReferenceId.Type
export const IdempotencyKey = OpaqueId.pipe(Schema.brand("HostedIdempotencyKey"))
export type IdempotencyKey = typeof IdempotencyKey.Type
export const RequestId = OpaqueId.pipe(Schema.brand("HostedRequestId"))
export type RequestId = typeof RequestId.Type
export const Sequence = Decimal.pipe(Schema.brand("HostedSequence"))
export type Sequence = typeof Sequence.Type
export const CommitCursor = Decimal.pipe(Schema.brand("HostedCommitCursor"))
export type CommitCursor = typeof CommitCursor.Type
export const ThreadVersion = Decimal.pipe(Schema.brand("HostedThreadVersion"))
export type ThreadVersion = typeof ThreadVersion.Type
export const ThreadEventCursor = Decimal.pipe(Schema.brand("HostedThreadEventCursor"))
export type ThreadEventCursor = typeof ThreadEventCursor.Type
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
const containsSecretMetadataKey = <Value>(value: Value): boolean => {
  if (Array.isArray(value)) return value.some(containsSecretMetadataKey)
  const record = Schema.decodeUnknownOption(JsonObject)(value)
  if (record._tag === "None") return false
  return Object.entries(record.value).some(
    ([key, nested]) => SecretMetadataKey.test(key) || containsSecretMetadataKey(nested),
  )
}
export const CredentialReferenceMetadata = JsonObject.check(
  Schema.makeFilter((metadata) =>
    containsSecretMetadataKey(metadata)
      ? [{ path: [], issue: "credential metadata must not contain secret material" }]
      : [],
  ),
)
export type CredentialReferenceMetadata = typeof CredentialReferenceMetadata.Type

export const ExecutorKind = Schema.Literals(["runner", "orb"])
export type ExecutorKind = typeof ExecutorKind.Type
export const GrantRole = Schema.Literals(["viewer", "controller", "operator", "owner"])
export type GrantRole = typeof GrantRole.Type
export const PresenceStatus = Schema.Literals(["viewing", "controlling", "away"])
export type PresenceStatus = typeof PresenceStatus.Type

export const PersonalOwner = Schema.TaggedStruct("PersonalOwner", {
  userId: BetterAuthUserId,
  organizationId: Schema.optionalKey(Schema.Never),
})
export type PersonalOwner = typeof PersonalOwner.Type
export const OrganizationOwner = Schema.TaggedStruct("OrganizationOwner", {
  organizationId: OrganizationId,
  userId: Schema.optionalKey(Schema.Never),
})
export type OrganizationOwner = typeof OrganizationOwner.Type
export const HostedOwner = Schema.Union([PersonalOwner, OrganizationOwner])
export type HostedOwner = typeof HostedOwner.Type

export const HostedOwnerRecord = Schema.Struct({
  id: OwnerId,
  identity: HostedOwner,
  createdAt: Timestamp,
})
export type HostedOwnerRecord = typeof HostedOwnerRecord.Type

export const ActorAttribution = Schema.Union([
  Schema.TaggedStruct("PersonalActor", {
    owner: PersonalOwner,
    userId: BetterAuthUserId,
    membershipId: Schema.optionalKey(Schema.Never),
    clientId: ClientId,
    deviceId: DeviceId,
  }),
  Schema.TaggedStruct("OrganizationActor", {
    owner: OrganizationOwner,
    userId: BetterAuthUserId,
    membershipId: BetterAuthMemberId,
    clientId: ClientId,
    deviceId: DeviceId,
  }),
])
export type ActorAttribution = typeof ActorAttribution.Type

export const Project = Schema.Struct({
  id: ProjectId,
  ownerId: OwnerId,
  name: Schema.NonEmptyString,
  createdByUserId: BetterAuthUserId,
  createdAt: Timestamp,
  updatedAt: Timestamp,
})
export type Project = typeof Project.Type

export const HostedWorkspace = Schema.Struct({
  id: WorkspaceId,
  ownerId: OwnerId,
  projectId: Schema.optionalKey(ProjectId),
  createdByUserId: BetterAuthUserId,
  executorKind: ExecutorKind,
  inheritProjectGrants: Schema.Boolean,
  createdAt: Timestamp,
})
export type HostedWorkspace = typeof HostedWorkspace.Type

export const ProjectGrant = Schema.Struct({
  ownerId: OwnerId,
  projectId: ProjectId,
  membershipId: BetterAuthMemberId,
  role: GrantRole,
  grantedByUserId: BetterAuthUserId,
  createdAt: Timestamp,
  updatedAt: Timestamp,
})
export type ProjectGrant = typeof ProjectGrant.Type

export const HostedThread = Schema.Struct({
  id: ThreadId,
  ownerId: OwnerId,
  projectId: Schema.optionalKey(ProjectId),
  workspaceId: WorkspaceId,
  createdByUserId: BetterAuthUserId,
  executorKind: ExecutorKind,
  inheritProjectGrants: Schema.Boolean,
  createdAt: Timestamp,
})
export type HostedThread = typeof HostedThread.Type

export const ThreadGrant = Schema.Struct({
  ownerId: OwnerId,
  threadId: ThreadId,
  membershipId: BetterAuthMemberId,
  role: GrantRole,
  grantedByUserId: BetterAuthUserId,
  createdAt: Timestamp,
  updatedAt: Timestamp,
})
export type ThreadGrant = typeof ThreadGrant.Type

export const AuthenticatedDevice = Schema.Struct({
  id: DeviceId,
  userId: BetterAuthUserId,
  displayName: Schema.NonEmptyString,
  publicKeyFingerprint: Schema.NonEmptyString,
  createdAt: Timestamp,
  lastSeenAt: Timestamp,
  revokedAt: Schema.NullOr(Timestamp),
})
export type AuthenticatedDevice = typeof AuthenticatedDevice.Type

export const AuthenticatedClient = Schema.Struct({
  id: ClientId,
  userId: BetterAuthUserId,
  deviceId: DeviceId,
  authenticatedAt: Timestamp,
  lastSeenAt: Timestamp,
  expiresAt: Timestamp,
  revokedAt: Schema.NullOr(Timestamp),
})
export type AuthenticatedClient = typeof AuthenticatedClient.Type

export const ThreadCommand = Schema.Struct({
  ownerId: OwnerId,
  threadId: ThreadId,
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
  ownerId: OwnerId,
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
  ownerId: OwnerId,
  threadId: ThreadId,
  actor: ActorAttribution,
  commitCursor: CommitCursor,
  updatedAt: Timestamp,
})
export type ResumableCursor = typeof ResumableCursor.Type

export const TerminalWriterLease = Schema.Struct({
  ownerId: OwnerId,
  threadId: ThreadId,
  actor: ActorAttribution,
  leaseId: LeaseId,
  generation: FencingGeneration,
  acquiredAt: Timestamp,
  renewedAt: Timestamp,
  expiresAt: Timestamp,
})
export type TerminalWriterLease = typeof TerminalWriterLease.Type

export const Presence = Schema.Struct({
  ownerId: OwnerId,
  threadId: ThreadId,
  actor: ActorAttribution,
  status: PresenceStatus,
  lastSeenAt: Timestamp,
  expiresAt: Timestamp,
})
export type Presence = typeof Presence.Type

export const AuditEvent = Schema.Struct({
  id: AuditEventId,
  ownerId: OwnerId,
  actor: ActorAttribution,
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
  ownerId: OwnerId,
  projectId: Schema.optionalKey(ProjectId),
  provider: Schema.NonEmptyString,
  purpose: Schema.NonEmptyString,
  externalReference: Schema.NonEmptyString,
  metadata: CredentialReferenceMetadata,
  createdByUserId: BetterAuthUserId,
  createdAt: Timestamp,
  updatedAt: Timestamp,
})
export type CredentialReference = typeof CredentialReference.Type
