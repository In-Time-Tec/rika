import { Schema } from "effect"
import {
  AssignmentLeaseEpoch,
  CheckpointId,
  DeviceId,
  ExecutorAssignmentId,
  ExecutorInstanceId,
  ExecutorKind,
  FencingGeneration,
  JsonObject,
  OrganizationId,
  Sequence,
  ThreadId,
  Timestamp,
} from "./model"

const OpaqueId = Schema.String.check(Schema.isPattern(/^[\x21-\x7e]{1,512}$/))

export const AssignmentRevision = Schema.String.check(Schema.isPattern(/^(0|[1-9][0-9]*)$/)).pipe(
  Schema.brand("HostedAssignmentRevision"),
)
export type AssignmentRevision = typeof AssignmentRevision.Type

export const ExecutorCursor = Schema.Struct({ sequence: Sequence, value: Schema.String })
export type ExecutorCursor = typeof ExecutorCursor.Type

export const EmptyExecutorCursor: ExecutorCursor = { sequence: Sequence.make("0"), value: "" }

export const RepositoryCheckout = Schema.Struct({
  repositoryId: OpaqueId,
  installationId: OpaqueId,
  owner: OpaqueId,
  name: OpaqueId,
  commitSha: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/i)),
})
export type RepositoryCheckout = typeof RepositoryCheckout.Type

export const LocalDevicePlacement = Schema.TaggedStruct("LocalDevicePlacement", {
  deviceId: DeviceId,
})
export type LocalDevicePlacement = typeof LocalDevicePlacement.Type

export const E2BPlacement = Schema.TaggedStruct("E2BPlacement", {
  templateBuildId: OpaqueId,
  providerScope: OpaqueId,
})
export type E2BPlacement = typeof E2BPlacement.Type

export const ExecutorPlacement = Schema.Union([LocalDevicePlacement, E2BPlacement])
export type ExecutorPlacement = typeof ExecutorPlacement.Type

export const PendingAssignment = Schema.TaggedStruct("Pending", {})
export type PendingAssignment = typeof PendingAssignment.Type

export const ProvisioningAssignment = Schema.TaggedStruct("Provisioning", {
  providerInstanceId: Schema.NullOr(OpaqueId),
  bootstrapExpiresAt: Timestamp,
})
export type ProvisioningAssignment = typeof ProvisioningAssignment.Type

export const AwaitingBootstrapAssignment = Schema.TaggedStruct("AwaitingBootstrap", {
  providerInstanceId: OpaqueId,
  bootstrapExpiresAt: Timestamp,
})
export type AwaitingBootstrapAssignment = typeof AwaitingBootstrapAssignment.Type

export const ActiveAssignment = Schema.TaggedStruct("Active", {
  providerInstanceId: OpaqueId,
  executorInstanceId: ExecutorInstanceId,
  processIncarnation: OpaqueId,
  leaseEpoch: AssignmentLeaseEpoch,
  leaseExpiresAt: Timestamp,
})
export type ActiveAssignment = typeof ActiveAssignment.Type

export const PausedAssignment = Schema.TaggedStruct("Paused", {
  providerInstanceId: OpaqueId,
})
export type PausedAssignment = typeof PausedAssignment.Type

export const TerminatedAssignment = Schema.TaggedStruct("Terminated", {})
export type TerminatedAssignment = typeof TerminatedAssignment.Type

export const AssignmentLifecycle = Schema.Union([
  PendingAssignment,
  ProvisioningAssignment,
  AwaitingBootstrapAssignment,
  ActiveAssignment,
  PausedAssignment,
  TerminatedAssignment,
])
export type AssignmentLifecycle = typeof AssignmentLifecycle.Type

export const ExecutorAssignment = Schema.Struct({
  id: ExecutorAssignmentId,
  organizationId: OrganizationId,
  threadId: ThreadId,
  executorKind: ExecutorKind,
  placement: ExecutorPlacement,
  checkout: RepositoryCheckout,
  generation: FencingGeneration,
  revision: AssignmentRevision,
  lastLeaseEpoch: Sequence,
  lifecycle: AssignmentLifecycle,
  cursor: ExecutorCursor,
  latestCheckpointId: Schema.NullOr(CheckpointId),
  lastActiveAt: Timestamp,
  createdAt: Timestamp,
  updatedAt: Timestamp,
})
export type ExecutorAssignment = typeof ExecutorAssignment.Type

export const WorkspaceCheckpointManifest = Schema.Struct({
  id: CheckpointId,
  organizationId: OrganizationId,
  threadId: ThreadId,
  assignmentId: ExecutorAssignmentId,
  executorInstanceId: ExecutorInstanceId,
  assignmentGeneration: FencingGeneration,
  leaseEpoch: AssignmentLeaseEpoch,
  objectKey: Schema.NonEmptyString,
  contentDigest: Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/)),
  sizeBytes: Schema.Int.check(Schema.isGreaterThan(0)),
  format: Schema.Literal("tar.zst"),
  cursor: ExecutorCursor,
  metadata: JsonObject,
  verifiedAt: Timestamp,
})
export type WorkspaceCheckpointManifest = typeof WorkspaceCheckpointManifest.Type
