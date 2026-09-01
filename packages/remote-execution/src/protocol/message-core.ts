import { WorkspaceCapabilitySnapshot } from "@rika/product/executor-assignment"
import {
  RepositoryServiceEnsure,
  RepositoryServiceResult,
  RepositoryServiceStop,
  WorkspaceFileInspect,
  WorkspaceFileInspection,
  WorkspaceRequest,
  WorkspaceResponse,
} from "@rika/product/workspace-capability"
import { Redacted, Schema } from "effect"
import { MaximumArchiveBytes, RepositoryIdentity } from "../workspace/artifact/archive"

export const Identifier = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512))
export const Generation = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
export const Sequence = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
export const Timestamp = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
export const ByteLength = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
export const Dimension = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(10_000))
export const Sha256 = Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/))
export const LeaseEpoch = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
export const OutputText = Schema.String.check(Schema.isMaxLength(16_384))
export const RequestDigest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
export const PtyData = Schema.String.check(Schema.isMaxLength(16_384))
export const EnvironmentName = Schema.String.check(Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/))
export const EnvironmentDigest = Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/))
const EncodedArchiveContent = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(Math.ceil(MaximumArchiveBytes / 3) * 4),
)

export const ProtocolVersion = Schema.Literal(1)
export type ProtocolVersion = typeof ProtocolVersion.Type

export const Target = Schema.Literals(["runner", "orb"])
export type Target = typeof Target.Type

export const ExecutorBootstrapIdentity = Schema.Struct({
  target: Schema.Literal("orb"),
  ownerId: Identifier,
  threadId: Identifier,
  assignmentId: Identifier,
  assignmentGeneration: Generation,
  instanceId: Identifier,
  executorId: Identifier,
  templateBuildId: Identifier,
  apiUrl: Identifier,
  workspaceId: Identifier,
  repository: Schema.NullOr(RepositoryIdentity),
  lifecycle: Schema.Literals(["fresh", "resume", "replacement"]),
  environmentDigest: Sha256,
  setupCache: Schema.Boolean,
})
export type ExecutorBootstrapIdentity = typeof ExecutorBootstrapIdentity.Type

export const EncodedArchive = Schema.Struct({
  content: EncodedArchiveContent,
  contentDigest: Sha256,
  sizeBytes: ByteLength,
})
export type EncodedArchive = typeof EncodedArchive.Type

export const CheckpointRestore = Schema.Struct({
  checkpointId: Identifier,
  archive: EncodedArchive,
})
export type CheckpointRestore = typeof CheckpointRestore.Type

export const WorkspaceSeedRestore = Schema.Struct({
  seedId: Identifier,
  archive: EncodedArchive,
})
export type WorkspaceSeedRestore = typeof WorkspaceSeedRestore.Type

export const ExecutorBootstrapWire = Schema.Struct({
  credential: Identifier,
  identity: ExecutorBootstrapIdentity,
  seed: Schema.NullOr(WorkspaceSeedRestore),
  restore: Schema.NullOr(CheckpointRestore),
})
export type ExecutorBootstrapWire = typeof ExecutorBootstrapWire.Type

/**
 * A one-use admission for a foreground executor on the user's device.
 *
 * `workspaceIdentity` is an opaque controller identity. It is deliberately
 * not a filesystem path: only the foreground process knows `workspacePath`.
 * This is separate from `ExecutorBootstrapWire`, whose E2B identity remains
 * attested by the sandbox bootstrap listener.
 */
export const RunnerAdmissionWire = Schema.Struct({
  assignmentId: Identifier,
  admissionId: Identifier,
  ticket: Identifier,
  executorUrl: Identifier,
  workspaceIdentity: Identifier,
  expiresAt: Timestamp,
})
export type RunnerAdmissionWire = typeof RunnerAdmissionWire.Type

export const Cursor = Schema.Struct({
  sequence: Sequence,
  value: Schema.String,
})
export type Cursor = typeof Cursor.Type

export const emptyCursor: Cursor = { sequence: 0, value: "" }

export const Frame = Schema.Struct({
  protocolVersion: ProtocolVersion,
  messageId: Identifier,
  assignmentId: Identifier,
  assignmentGeneration: Generation,
  leaseEpoch: LeaseEpoch,
  directionalSequence: Sequence,
  acknowledgement: Sequence,
  kind: Identifier,
  body: Schema.Unknown,
})
export type Frame = typeof Frame.Type

export const PtyGap = Schema.Struct({
  fromCursor: Sequence,
  toCursor: Sequence,
})
export type PtyGap = typeof PtyGap.Type

export const Fence = Schema.Struct({
  target: Target,
  assignmentId: Identifier,
  assignmentGeneration: Generation,
  instanceId: Identifier,
  executorId: Identifier,
  processIncarnation: Identifier,
})
export type Fence = typeof Fence.Type

export const Capabilities = Schema.Struct({
  nativeTools: Schema.Boolean,
  checkpoints: Schema.Boolean,
  pty: Schema.Boolean,
})
export type Capabilities = typeof Capabilities.Type

export {
  RepositoryServiceEnsure,
  RepositoryServiceResult,
  RepositoryServiceStop,
  WorkspaceFileInspect,
  WorkspaceFileInspection,
  WorkspaceRequest,
  WorkspaceResponse,
}

export const ResumeCursors = Schema.Struct({
  command: Sequence,
  event: Sequence,
  pty: Sequence,
})
export type ResumeCursors = typeof ResumeCursors.Type

export const HelloWire = Schema.Struct({
  minimumVersion: ProtocolVersion,
  maximumVersion: ProtocolVersion,
  fence: Fence,
  templateBuildId: Schema.NullOr(Identifier),
  capabilities: Capabilities,
  workspaceCapabilities: WorkspaceCapabilitySnapshot,
  cursors: ResumeCursors,
  latestCheckpointId: Schema.NullOr(Identifier),
  bootstrapToken: Identifier,
})
export type HelloWire = typeof HelloWire.Type

export interface Hello extends Omit<HelloWire, "bootstrapToken"> {
  readonly bootstrapToken: Redacted.Redacted<string>
}

export const redactHello = (hello: HelloWire): Hello => ({
  ...hello,
  bootstrapToken: Redacted.make(hello.bootstrapToken, { label: "executor-bootstrap" }),
})

export const AccessWire = Schema.Struct({
  version: ProtocolVersion,
  fence: Fence,
  leaseEpoch: LeaseEpoch,
  sessionToken: Identifier,
})
export type AccessWire = typeof AccessWire.Type

export interface Access extends Omit<AccessWire, "sessionToken"> {
  readonly sessionToken: Redacted.Redacted<string>
}

export const redactAccess = (access: AccessWire): Access => ({
  ...access,
  sessionToken: Redacted.make(access.sessionToken, { label: "executor-session" }),
})
