import { WorkspaceCapabilitySnapshot } from "@rika/product/executor-assignment"
import { runnerProtocolVersion } from "@rika/product/runner-registration"
import { Schema } from "effect"
import {
  AccessWire,
  ByteLength,
  Capabilities,
  Cursor,
  Dimension,
  EncodedArchive,
  Fence,
  Generation,
  Identifier,
  LeaseEpoch,
  ProtocolVersion,
  PtyData,
  ResumeCursors,
  Sequence,
  Sha256,
  Timestamp,
} from "./message-core"

export const FilesystemCheckpoint = Schema.Struct({
  version: ProtocolVersion,
  checkpointId: Identifier,
  objectKey: Identifier,
  contentDigest: Sha256,
  sizeBytes: ByteLength,
  format: Schema.Literal("tar.zst"),
  cursor: Cursor,
})
export type FilesystemCheckpoint = typeof FilesystemCheckpoint.Type

export const CheckpointProposal = Schema.Struct({
  version: ProtocolVersion,
  checkpointId: Identifier,
  archive: EncodedArchive,
  cursor: Cursor,
})
export type CheckpointProposal = typeof CheckpointProposal.Type

export const WorkspaceProof = Schema.Struct({
  workspaceId: Identifier,
  repositoryId: Schema.NullOr(Identifier),
  baseCommit: Schema.NullOr(Identifier),
  headCommit: Schema.NullOr(Identifier),
  setupHookDigest: Sha256,
  environmentDigest: Sha256,
  templateBuildId: Identifier,
  restoredCheckpointId: Schema.NullOr(Identifier),
})
export type WorkspaceProof = typeof WorkspaceProof.Type

export const PtyCreate = Schema.Struct({
  ptyId: Identifier,
  command: Schema.NonEmptyString,
  cwd: Schema.NonEmptyString,
  cols: Dimension,
  rows: Dimension,
})
export type PtyCreate = typeof PtyCreate.Type

export const PtyInput = Schema.Struct({ ptyId: Identifier, data: PtyData })
export type PtyInput = typeof PtyInput.Type

export const PtyResize = Schema.Struct({ ptyId: Identifier, cols: Dimension, rows: Dimension })
export type PtyResize = typeof PtyResize.Type

export const PtyReconnect = Schema.Struct({ ptyId: Identifier, cursor: Sequence })
export type PtyReconnect = typeof PtyReconnect.Type

export const PtyTranscriptChunk = Schema.Struct({
  cursor: Sequence,
  data: PtyData,
})
export type PtyTranscriptChunk = typeof PtyTranscriptChunk.Type

export const WelcomeWire = Schema.Struct({
  version: ProtocolVersion,
  fence: Fence,
  leaseEpoch: LeaseEpoch,
  sessionToken: Identifier,
  leaseExpiresAt: Timestamp,
  heartbeatIntervalMillis: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  cursor: Cursor,
})
export type WelcomeWire = typeof WelcomeWire.Type

export const ReconnectWelcomeWire = Schema.Struct({
  version: ProtocolVersion,
  fence: Fence,
  leaseEpoch: LeaseEpoch,
  leaseExpiresAt: Timestamp,
  heartbeatIntervalMillis: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  cursor: Cursor,
})
export type ReconnectWelcomeWire = typeof ReconnectWelcomeWire.Type

export const ReceiptWire = Schema.Struct({
  version: ProtocolVersion,
  fence: Fence,
  leaseEpoch: LeaseEpoch,
  leaseExpiresAt: Timestamp,
  cursor: Cursor,
})
export type ReceiptWire = typeof ReceiptWire.Type

export const SessionWire = Schema.Struct({
  version: ProtocolVersion,
  fence: Fence,
  leaseEpoch: LeaseEpoch,
  sessionToken: Identifier,
  heartbeatIntervalMillis: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  cursor: Cursor,
})
export type SessionWire = typeof SessionWire.Type

export const CredentialWire = Schema.Struct({
  requestId: Identifier,
  ownerId: Identifier,
  assignmentId: Identifier,
  repositoryId: Identifier,
  workspaceId: Identifier,
  purpose: Schema.Literals(["git-read", "github-read", "branch-push"]),
  publicationId: Schema.optionalKey(Identifier),
  branch: Schema.optionalKey(Identifier),
  ref: Schema.optionalKey(Identifier),
  commitSha: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/))),
  assignmentGeneration: Generation,
  leaseEpoch: LeaseEpoch,
  repositoryUrl: Identifier,
  username: Schema.Literal("x-access-token"),
  token: Identifier,
  expiresAt: Timestamp,
})

export const BranchPushOutcome = Schema.Union([
  Schema.TaggedStruct("Succeeded", {
    branch: Identifier,
    ref: Identifier,
    commitSha: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/)),
  }),
  Schema.TaggedStruct("Failed", {
    kind: Schema.Literals(["stale", "local", "git"]),
    message: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
  }),
])
export type BranchPushOutcome = typeof BranchPushOutcome.Type

export const BranchPushRequest = Schema.Struct({
  access: AccessWire,
  publicationId: Identifier,
  ownerId: Identifier,
  repositoryId: Identifier,
  workspaceId: Identifier,
  branch: Identifier,
  ref: Identifier,
  commitSha: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/)),
})
export type BranchPushRequest = typeof BranchPushRequest.Type

export const RepositoryCheckoutWire = Schema.Struct({
  ownerId: Identifier,
  projectId: Identifier,
  repositoryId: Identifier,
  installationId: Identifier,
  owner: Identifier,
  name: Identifier,
  ref: Identifier,
  commitSha: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/)),
  private: Schema.Boolean,
  gitIdentity: Schema.Struct({ name: Identifier, email: Identifier }),
})
export type RepositoryCheckoutWire = typeof RepositoryCheckoutWire.Type

export const WorkspacePreparationPhase = Schema.Literals(["checkout", "setup", "resume", "capabilities"])
export type WorkspacePreparationPhase = typeof WorkspacePreparationPhase.Type

const HookEvidenceWire = Schema.Struct({
  digest: Schema.NullOr(Sha256),
  commitSha: Schema.NullOr(Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/))),
  buildDigest: Sha256,
  environmentDigest: Sha256,
  startedAt: Timestamp,
  finishedAt: Timestamp,
  outcome: Schema.Literals(["missing", "completed", "continued", "failed"]),
})

export const WorkspacePreparationEvidenceWire = Schema.Struct({
  workspaceId: Identifier,
  repositoryId: Schema.NullOr(Identifier),
  commitSha: Schema.NullOr(Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/))),
  nativeToolRuntimeDigest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  setup: HookEvidenceWire,
  resume: Schema.NullOr(HookEvidenceWire),
  capabilities: Schema.Array(Identifier).check(Schema.isMaxLength(32)),
  lifecycle: Schema.Struct({
    environmentDigest: Sha256,
    templateBuildId: Identifier,
    setupHookDigest: Sha256,
    restoredCheckpointId: Schema.NullOr(Identifier),
  }),
})
export type WorkspacePreparationEvidenceWire = typeof WorkspacePreparationEvidenceWire.Type

export const RunnerHelloWire = Schema.Struct({
  protocolVersion: Schema.Literal(runnerProtocolVersion),
  admissionId: Identifier,
  ticket: Identifier,
  processIncarnation: Identifier,
  capabilities: Capabilities,
  workspaceCapabilities: WorkspaceCapabilitySnapshot,
  cursors: ResumeCursors,
})
export type RunnerHelloWire = typeof RunnerHelloWire.Type
