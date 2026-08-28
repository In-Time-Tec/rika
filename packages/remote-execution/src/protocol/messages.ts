import * as CodingToolResult from "@rika/coding-tools/coding-tool-result"
import * as CodingToolRuntime from "@rika/coding-tools/coding-tool-runtime"
import * as McpConfiguration from "@rika/extensions/mcp-configuration"
import * as McpRuntime from "@rika/extensions/mcp-runtime"
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
import { Crypto, Effect, Encoding, Redacted, Schema } from "effect"
import { MaximumArchiveBytes, RepositoryIdentity, SetupCacheKey } from "../workspace/archive"

const Identifier = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512))
const Generation = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
const Sequence = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const Timestamp = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const ByteLength = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
const Dimension = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(10_000))
const Sha256 = Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/))
const LeaseEpoch = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
const OutputText = Schema.String.check(Schema.isMaxLength(16_384))
const RequestDigest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
const PtyData = Schema.String.check(Schema.isMaxLength(16_384))
const EnvironmentName = Schema.String.check(Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/))
const EnvironmentDigest = Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/))
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

export const OperationFence = Schema.Struct({
  operationKey: Identifier,
  attempt: Generation,
})
export type OperationFence = typeof OperationFence.Type

export const OperationReplayPolicy = Schema.Literals(["pure", "provider-idempotent", "never"])
export type OperationReplayPolicy = typeof OperationReplayPolicy.Type

export const TerminalOutcome = Schema.Literals(["accepted", "unknown"])
export type TerminalOutcome = typeof TerminalOutcome.Type

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
  cells: Schema.Boolean,
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

export const BindingDescriptor = Schema.Struct({
  module: Identifier,
  operations: Schema.Array(Identifier),
})
export type BindingDescriptor = typeof BindingDescriptor.Type

export const BindingContractDigest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
export type BindingContractDigest = typeof BindingContractDigest.Type

export const BindingManifest = Schema.Struct({
  digest: BindingContractDigest,
  descriptors: Schema.Array(BindingDescriptor),
})
export type BindingManifest = typeof BindingManifest.Type

const encodeBindingDescriptors = Schema.encodeSync(Schema.fromJsonString(Schema.Array(BindingDescriptor)))

export const bindingManifest = Effect.fn("RemoteExecution.bindingManifest")(function* (
  descriptors: ReadonlyArray<BindingDescriptor>,
) {
  const crypto = yield* Crypto.Crypto
  const digest = Encoding.encodeHex(
    yield* crypto.digest("SHA-256", new TextEncoder().encode(encodeBindingDescriptors(descriptors))).pipe(Effect.orDie),
  )
  return BindingManifest.make({ digest, descriptors })
})

export const BindingRequest = Schema.Struct({
  module: Identifier,
  operation: Identifier,
  input: Schema.optionalKey(Schema.Json),
  sessionId: Schema.optionalKey(Identifier),
  cellId: Schema.optionalKey(Identifier),
})
export type BindingRequest = typeof BindingRequest.Type

export const BindingResponse = Schema.Union([
  Schema.TaggedStruct("Success", { output: Schema.optionalKey(Schema.Json) }),
  Schema.TaggedStruct("Failure", { failure: Schema.Json }),
])
export type BindingResponse = typeof BindingResponse.Type

export const BindingBoundaryFailure = Schema.Union([
  Schema.TaggedStruct("tenetkit/repl/HostBindingNotFound", {
    module: Identifier,
    operation: Schema.optionalKey(Identifier),
  }),
  Schema.TaggedStruct("tenetkit/repl/HostBindingSchemaFailure", {
    module: Identifier,
    operation: Identifier,
    stage: Schema.Literals(["decode-input", "encode-output", "encode-failure"]),
    message: Schema.String,
  }),
])

export const BindingOutcome = Schema.Union([
  Schema.TaggedStruct("Returned", { response: BindingResponse }),
  Schema.TaggedStruct("Rejected", { failure: BindingBoundaryFailure }),
  Schema.TaggedStruct("Suspend", { token: Identifier }),
  Schema.TaggedStruct("Unknown", { message: Schema.String }),
])
export type BindingOutcome = typeof BindingOutcome.Type

export const MachineRequest = Schema.Union([
  Schema.TaggedStruct("CodingTool", { request: CodingToolRuntime.Request }),
  Schema.TaggedStruct("ProcessStop", { processId: Identifier }),
  Schema.TaggedStruct("McpDiscover", { server: McpConfiguration.Server }),
  Schema.TaggedStruct("McpCall", { server: McpConfiguration.Server, tool: Identifier, input: Schema.Json }),
])
export type MachineRequest = typeof MachineRequest.Type

const DiscoveredMcpTool = Schema.Struct({
  name: Schema.String,
  rawName: Schema.String,
  description: Schema.String,
  inputSchema: Schema.Json,
  outputSchema: Schema.Json,
})

export const MachineSuccess = Schema.Union([
  Schema.TaggedStruct("CodingTool", { result: CodingToolResult.Result }),
  Schema.TaggedStruct("ProcessStopped", {}),
  Schema.TaggedStruct("McpDiscovered", { tools: Schema.Array(DiscoveredMcpTool) }),
  Schema.TaggedStruct("McpCalled", { content: Schema.Json }),
])

export const MachineFailure = Schema.Union([
  CodingToolRuntime.ToolError,
  McpRuntime.Diagnostic,
  Schema.TaggedStruct("ProcessStopFailed", { message: Schema.String }),
])

export const MachineOutcome = Schema.Union([
  Schema.TaggedStruct("Success", { value: MachineSuccess }),
  Schema.TaggedStruct("Failure", { failure: MachineFailure }),
  Schema.TaggedStruct("Cancelled", {}),
  Schema.TaggedStruct("Unknown", { message: Schema.String }),
  Schema.TaggedStruct("Fenced", { message: Schema.String }),
])
export type MachineOutcome = typeof MachineOutcome.Type

export const CellRequest = Schema.Struct({
  access: AccessWire,
  operationKey: Identifier,
  workspaceId: Identifier,
  sessionId: Identifier,
  threadId: Identifier,
  turnId: Identifier,
  runId: Identifier,
  rootRunId: Identifier,
  toolCallId: Identifier,
  code: Schema.String,
  attempt: Sequence,
  replayPolicy: OperationReplayPolicy,
  admittedAt: Schema.NullOr(Identifier),
  deadlineAt: Identifier,
  bindings: BindingManifest,
})
export type CellRequest = typeof CellRequest.Type

export const CellAttribution = Schema.Struct({
  operationKey: Identifier,
  workspaceId: Identifier,
  sessionId: Identifier,
  threadId: Identifier,
  turnId: Identifier,
  runId: Identifier,
  rootRunId: Identifier,
  toolCallId: Identifier,
  attempt: Sequence,
})
export type CellAttribution = typeof CellAttribution.Type

export const CellResponse = Schema.Union([
  Schema.TaggedStruct("Success", { result: Schema.Json }),
  Schema.TaggedStruct("DomainFailure", { failure: Schema.Json }),
  Schema.TaggedStruct("Suspend", { token: Schema.String }),
])
export type CellResponse = typeof CellResponse.Type

export const CellTerminalOutcome = Schema.Literals(["completed", "failed", "cancelled", "unknown"])
export type CellTerminalOutcome = typeof CellTerminalOutcome.Type

export const CellLifecycleFrame = Schema.Union([
  Schema.TaggedStruct("Accepted", { attribution: CellAttribution, cursor: Sequence }),
  Schema.TaggedStruct("Started", { attribution: CellAttribution, cursor: Sequence }),
  Schema.TaggedStruct("Output", {
    attribution: CellAttribution,
    cursor: Sequence,
    stream: Schema.Literals(["stdout", "stderr"]),
    text: OutputText,
    redacted: Schema.Literal(true),
    truncated: Schema.Boolean,
  }),
  Schema.TaggedStruct("Terminal", {
    attribution: CellAttribution,
    cursor: Sequence,
    outcome: CellTerminalOutcome,
    response: CellResponse,
  }),
])
export type CellLifecycleFrame = typeof CellLifecycleFrame.Type

export const HeartbeatWire = Schema.Struct({
  version: ProtocolVersion,
  access: AccessWire,
  cursor: Cursor,
})
export type HeartbeatWire = typeof HeartbeatWire.Type

export interface Heartbeat extends Omit<HeartbeatWire, "access"> {
  readonly access: Access
}

export const redactHeartbeat = (heartbeat: HeartbeatWire): Heartbeat => ({
  ...heartbeat,
  access: redactAccess(heartbeat.access),
})

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

export const QuiescedOperation = Schema.Struct({
  operationKey: Identifier,
  outcome: CellTerminalOutcome,
})
export type QuiescedOperation = typeof QuiescedOperation.Type

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

export const HookEvidenceWire = Schema.Struct({
  digest: Schema.NullOr(Sha256),
  commitSha: Schema.NullOr(Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/))),
  buildDigest: Sha256,
  environmentDigest: Sha256,
  startedAt: Timestamp,
  finishedAt: Timestamp,
  outcome: Schema.Literals(["missing", "completed", "continued"]),
})

export const WorkspacePreparationEvidenceWire = Schema.Struct({
  workspaceId: Identifier,
  repositoryId: Schema.NullOr(Identifier),
  commitSha: Schema.NullOr(Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/))),
  kernelProfileDigest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  bindingContractDigest: BindingContractDigest,
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
  admissionId: Identifier,
  ticket: Identifier,
  processIncarnation: Identifier,
  capabilities: Capabilities,
  workspaceCapabilities: WorkspaceCapabilitySnapshot,
  cursors: ResumeCursors,
})
export type RunnerHelloWire = typeof RunnerHelloWire.Type

/** Frames accepted only on the foreground Runner socket. */
export const RunnerMessage = Schema.Union([
  Schema.TaggedStruct("RunnerHello", { hello: RunnerHelloWire }),
  Schema.TaggedStruct("ExecutorReconnect", { access: AccessWire }),
  Schema.TaggedStruct("ExecutorHeartbeat", { heartbeat: HeartbeatWire }),
  Schema.TaggedStruct("RunnerGoodbye", { access: AccessWire }),
  Schema.TaggedStruct("LocalCellResult", {
    access: AccessWire,
    operationKey: Identifier,
    attempt: Sequence,
    response: CellResponse,
  }),
  Schema.TaggedStruct("CellLifecycle", { access: AccessWire, frame: CellLifecycleFrame }),
  Schema.TaggedStruct("BindingInvoke", {
    access: AccessWire,
    operationKey: Identifier,
    attempt: Sequence,
    callId: Identifier,
    requestDigest: RequestDigest,
    request: BindingRequest,
  }),
  Schema.TaggedStruct("MachineResult", {
    access: AccessWire,
    operationKey: Identifier,
    attempt: Sequence,
    machineId: Identifier,
    requestDigest: RequestDigest,
    outcome: MachineOutcome,
  }),
])
export type RunnerMessage = typeof RunnerMessage.Type

export const ExecutorMessage = Schema.Union([
  Schema.TaggedStruct("ExecutorHello", {
    hello: HelloWire,
    lifecycle: Schema.Literals(["fresh", "resume", "replacement"]),
    environmentDigest: EnvironmentDigest,
  }),
  Schema.TaggedStruct("ExecutorReconnect", { access: AccessWire }),
  Schema.TaggedStruct("ExecutorHeartbeat", { heartbeat: HeartbeatWire }),
  Schema.TaggedStruct("CredentialRequested", {
    requestId: Identifier,
    access: AccessWire,
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
  }),
  Schema.TaggedStruct("CredentialRevocationRequested", {
    access: AccessWire,
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
  }),
  Schema.TaggedStruct("WorkspacePreparationRequested", {
    access: AccessWire,
    workspaceId: Identifier,
    wakeId: Identifier,
    cold: Schema.Boolean,
    attempt: Generation,
    retry: Schema.Boolean,
  }),
  Schema.TaggedStruct("WorkspacePreparationStarted", {
    access: AccessWire,
    workspaceId: Identifier,
    phase: WorkspacePreparationPhase,
    attempt: Generation,
  }),
  Schema.TaggedStruct("WorkspacePreparationOutput", {
    access: AccessWire,
    workspaceId: Identifier,
    phase: WorkspacePreparationPhase,
    attempt: Generation,
    stream: Schema.Literals(["stdout", "stderr"]),
    text: OutputText,
    redacted: Schema.Literal(true),
    truncated: Schema.Boolean,
  }),
  Schema.TaggedStruct("WorkspacePreparationReady", {
    access: AccessWire,
    workspaceId: Identifier,
    phase: WorkspacePreparationPhase,
    attempt: Generation,
    evidence: WorkspacePreparationEvidenceWire,
  }),
  Schema.TaggedStruct("WorkspacePreparationFailed", {
    access: AccessWire,
    workspaceId: Identifier,
    phase: WorkspacePreparationPhase,
    attempt: Generation,
    message: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2_048)),
    retryable: Schema.Boolean,
  }),
  Schema.TaggedStruct("ExecutorWorkspaceReady", {
    access: AccessWire,
    proof: WorkspaceProof,
    capabilities: WorkspaceCapabilitySnapshot,
  }),
  Schema.TaggedStruct("ExecutorQuiesced", {
    access: AccessWire,
    requestId: Identifier,
    operations: Schema.Array(QuiescedOperation),
    checkpoint: CheckpointProposal,
  }),
  Schema.TaggedStruct("SetupCacheLookup", {
    access: AccessWire,
    requestId: Identifier,
    key: SetupCacheKey,
  }),
  Schema.TaggedStruct("SetupCacheProposed", {
    access: AccessWire,
    requestId: Identifier,
    key: SetupCacheKey,
    archive: EncodedArchive,
  }),
  Schema.TaggedStruct("BranchPushResult", {
    access: AccessWire,
    publicationId: Identifier,
    branch: Identifier,
    commitSha: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/)),
    outcome: BranchPushOutcome,
  }),
  Schema.TaggedStruct("PtyOpened", { access: AccessWire, pty: PtyCreate }),
  Schema.TaggedStruct("PtyOutput", { access: AccessWire, ptyId: Identifier, chunk: PtyTranscriptChunk }),
  Schema.TaggedStruct("PtyReplayGap", { access: AccessWire, ptyId: Identifier, gap: PtyGap }),
  Schema.TaggedStruct("PtyDisconnected", { access: AccessWire, ptyId: Identifier, cursor: Sequence }),
  Schema.TaggedStruct("PtyTerminated", { access: AccessWire, ptyId: Identifier, cursor: Sequence }),
  Schema.TaggedStruct("WorkspaceResponse", { access: AccessWire, response: WorkspaceResponse }),
  Schema.TaggedStruct("CellResult", {
    access: AccessWire,
    operationKey: Identifier,
    attempt: Sequence,
    response: CellResponse,
  }),
  Schema.TaggedStruct("CellLifecycle", { access: AccessWire, frame: CellLifecycleFrame }),
  Schema.TaggedStruct("BindingInvoke", {
    access: AccessWire,
    operationKey: Identifier,
    attempt: Sequence,
    callId: Identifier,
    requestDigest: RequestDigest,
    request: BindingRequest,
  }),
  Schema.TaggedStruct("MachineResult", {
    access: AccessWire,
    operationKey: Identifier,
    attempt: Sequence,
    machineId: Identifier,
    requestDigest: RequestDigest,
    outcome: MachineOutcome,
  }),
])
export type ExecutorMessage = typeof ExecutorMessage.Type

export const ApiMessage = Schema.Union([
  Schema.TaggedStruct("ExecutorWelcome", { welcome: WelcomeWire }),
  Schema.TaggedStruct("ExecutorReconnected", { welcome: ReconnectWelcomeWire }),
  Schema.TaggedStruct("PhaseEnvironmentGranted", {
    phase: Schema.Literals(["setup", "runtime"]),
    digest: EnvironmentDigest,
    operationKey: Schema.NullOr(Identifier),
    values: Schema.Record(EnvironmentName, Schema.String),
    redactedNames: Schema.Array(EnvironmentName),
  }),
  Schema.TaggedStruct("LeaseReceipt", { receipt: ReceiptWire }),
  Schema.TaggedStruct("LocalCellReceipt", { access: AccessWire, operationKey: Identifier, attempt: Sequence }),
  Schema.TaggedStruct("CheckpointAccepted", { checkpointId: Identifier, contentDigest: Sha256 }),
  Schema.TaggedStruct("RepositoryCredential", { credential: CredentialWire }),
  Schema.TaggedStruct("WorkspacePreparationAssigned", {
    access: AccessWire,
    workspaceId: Identifier,
    wakeId: Identifier,
    cold: Schema.Boolean,
    attempt: Generation,
    retry: Schema.Boolean,
    templateBuildId: Identifier,
    bindingContractDigest: BindingContractDigest,
    checkout: Schema.NullOr(RepositoryCheckoutWire),
  }),
  Schema.TaggedStruct("WorkspacePreparationRetry", { fence: Fence, attempt: Generation }),
  Schema.TaggedStruct("WorkspaceAccepted", { fence: Fence }),
  Schema.TaggedStruct("Quiesce", { fence: Fence, requestId: Identifier }),
  Schema.TaggedStruct("SetupCacheResult", {
    requestId: Identifier,
    archive: Schema.NullOr(EncodedArchive),
  }),
  Schema.TaggedStruct("SetupCacheAccepted", { requestId: Identifier }),
  Schema.TaggedStruct("BranchPush", { request: BranchPushRequest }),
  Schema.TaggedStruct("PtyCreate", { fence: Fence, request: PtyCreate }),
  Schema.TaggedStruct("PtyInput", { fence: Fence, request: PtyInput }),
  Schema.TaggedStruct("PtyResize", { fence: Fence, request: PtyResize }),
  Schema.TaggedStruct("PtyDisconnect", { fence: Fence, ptyId: Identifier }),
  Schema.TaggedStruct("PtyReconnect", { fence: Fence, request: PtyReconnect }),
  Schema.TaggedStruct("PtyTerminate", { fence: Fence, ptyId: Identifier }),
  Schema.TaggedStruct("WorkspaceRequest", { fence: Fence, request: WorkspaceRequest }),
  Schema.TaggedStruct("CellExecute", { request: CellRequest }),
  Schema.TaggedStruct("CellCancel", { access: AccessWire, operationKey: Identifier, attempt: Sequence }),
  Schema.TaggedStruct("CellReplay", {
    access: AccessWire,
    operationKey: Identifier,
    attempt: Sequence,
    afterCursor: Sequence,
  }),
  Schema.TaggedStruct("CellTerminalReceipt", {
    access: AccessWire,
    operationKey: Identifier,
    attempt: Sequence,
    cursor: Sequence,
  }),
  Schema.TaggedStruct("CellTerminalSuperseded", {
    access: AccessWire,
    operationKey: Identifier,
    attempt: Sequence,
    cursor: Sequence,
    outcome: CellTerminalOutcome,
    response: CellResponse,
  }),
  Schema.TaggedStruct("BindingResult", {
    access: AccessWire,
    operationKey: Identifier,
    attempt: Sequence,
    callId: Identifier,
    requestDigest: RequestDigest,
    outcome: BindingOutcome,
  }),
  Schema.TaggedStruct("MachineExecute", {
    access: AccessWire,
    operationKey: Identifier,
    attempt: Sequence,
    machineId: Identifier,
    requestDigest: RequestDigest,
    request: MachineRequest,
  }),
  Schema.TaggedStruct("Fenced", { fence: Fence, message: Schema.String }),
])
export type ApiMessage = typeof ApiMessage.Type

export class ProtocolError extends Schema.TaggedError<ProtocolError>()("ProtocolError", {
  kind: Schema.Literals(["authentication", "cursor", "fenced", "phase", "protocol"]),
  message: Schema.String,
}) {}
