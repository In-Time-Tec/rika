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
  OwnerId,
  Sequence,
  ThreadId,
  Timestamp,
  WorkspaceId,
} from "./model"
import { CheckoutFingerprint } from "./local-runner-registration"

const OpaqueId = Schema.String.check(Schema.isPattern(/^[\x21-\x7e]{1,512}$/))

export const AssignmentRevision = Schema.String.check(Schema.isPattern(/^(0|[1-9][0-9]*)$/)).pipe(
  Schema.brand("HostedAssignmentRevision"),
)
export type AssignmentRevision = typeof AssignmentRevision.Type

export const ExecutorCursor = Schema.Struct({ sequence: Sequence, value: Schema.String })
export type ExecutorCursor = typeof ExecutorCursor.Type

export const EmptyExecutorCursor: ExecutorCursor = { sequence: Sequence.make("0"), value: "" }

export const WorkspaceCapability = Schema.Union([
  Schema.TaggedStruct("Ready", { detail: Schema.NonEmptyString }),
  Schema.TaggedStruct("Unavailable", { reason: Schema.NonEmptyString }),
])
export type WorkspaceCapability = typeof WorkspaceCapability.Type

export const WorkspaceCapabilitySnapshot = Schema.Struct({
  environmentDigest: Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/)),
  capturedAt: Timestamp,
  filesystem: WorkspaceCapability,
  typescriptKernel: WorkspaceCapability,
  git: WorkspaceCapability,
  process: WorkspaceCapability,
  pty: WorkspaceCapability,
  browser: WorkspaceCapability,
  workspaceLifecycle: WorkspaceCapability,
})
export type WorkspaceCapabilitySnapshot = typeof WorkspaceCapabilitySnapshot.Type

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
  checkoutFingerprint: CheckoutFingerprint,
  requestingDeviceId: DeviceId,
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

const ExecutorAssignmentStruct = Schema.Struct({
  id: ExecutorAssignmentId,
  ownerId: OwnerId,
  threadId: ThreadId,
  workspaceId: WorkspaceId,
  executorKind: ExecutorKind,
  placement: ExecutorPlacement,
  checkout: Schema.NullOr(RepositoryCheckout),
  generation: FencingGeneration,
  revision: AssignmentRevision,
  lastLeaseEpoch: Sequence,
  lifecycle: AssignmentLifecycle,
  capabilityGeneration: Schema.NullOr(FencingGeneration),
  capabilities: Schema.NullOr(WorkspaceCapabilitySnapshot),
  cursor: ExecutorCursor,
  latestCheckpointId: Schema.NullOr(CheckpointId),
  lastActiveAt: Timestamp,
  createdAt: Timestamp,
  updatedAt: Timestamp,
})
export const ExecutorAssignment = ExecutorAssignmentStruct.check(
  Schema.makeFilter((assignment) =>
    (assignment.executorKind === "e2b" && assignment.placement._tag === "E2BPlacement") ||
    (assignment.executorKind === "local_device" && assignment.placement._tag === "LocalDevicePlacement")
      ? []
      : [{ path: ["placement"], issue: "placement must match executor kind" }],
  ),
  Schema.makeFilter((assignment) =>
    (assignment.capabilityGeneration === null && assignment.capabilities === null) ||
    (assignment.capabilityGeneration === assignment.generation && assignment.capabilities !== null)
      ? []
      : [{ path: ["capabilities"], issue: "capability snapshot must match the assignment generation" }],
  ),
)
export type ExecutorAssignment = typeof ExecutorAssignment.Type

export const WorkspaceCheckpointManifest = Schema.Struct({
  id: CheckpointId,
  ownerId: OwnerId,
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
