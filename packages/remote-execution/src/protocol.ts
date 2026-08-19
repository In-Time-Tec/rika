import { Redacted, Schema } from "effect"

const Identifier = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512))
const Generation = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
const Sequence = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const Timestamp = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const ByteLength = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
const Dimension = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(10_000))
const Sha256 = Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/))
const LeaseEpoch = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))

export const ProtocolVersion = Schema.Literal(1)
export type ProtocolVersion = typeof ProtocolVersion.Type

export const Target = Schema.Literals(["local_device", "e2b"])
export type Target = typeof Target.Type

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

export const PtyCreate = Schema.Struct({
  ptyId: Identifier,
  command: Schema.NonEmptyString,
  cwd: Schema.NonEmptyString,
  cols: Dimension,
  rows: Dimension,
})
export type PtyCreate = typeof PtyCreate.Type

export const PtyInput = Schema.Struct({ ptyId: Identifier, data: Schema.String })
export type PtyInput = typeof PtyInput.Type

export const PtyResize = Schema.Struct({ ptyId: Identifier, cols: Dimension, rows: Dimension })
export type PtyResize = typeof PtyResize.Type

export const PtyReconnect = Schema.Struct({ ptyId: Identifier, cursor: Sequence })
export type PtyReconnect = typeof PtyReconnect.Type

export const PtyTranscriptChunk = Schema.Struct({
  cursor: Sequence,
  data: Schema.String,
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
  repositoryUrl: Identifier,
  username: Schema.Literal("x-access-token"),
  token: Identifier,
  expiresAt: Timestamp,
})

export const HostMessage = Schema.Union([
  Schema.TaggedStruct("ExecutorHello", { hello: HelloWire }),
  Schema.TaggedStruct("ExecutorReconnect", { access: AccessWire }),
  Schema.TaggedStruct("ExecutorHeartbeat", { heartbeat: HeartbeatWire }),
  Schema.TaggedStruct("CheckpointStaged", { access: AccessWire, checkpoint: FilesystemCheckpoint }),
  Schema.TaggedStruct("CheckoutRequested", { requestId: Identifier, access: AccessWire }),
  Schema.TaggedStruct("PtyOpened", { access: AccessWire, pty: PtyCreate }),
  Schema.TaggedStruct("PtyOutput", { access: AccessWire, ptyId: Identifier, chunk: PtyTranscriptChunk }),
  Schema.TaggedStruct("PtyDisconnected", { access: AccessWire, ptyId: Identifier, cursor: Sequence }),
])
export type HostMessage = typeof HostMessage.Type

export const ControllerMessage = Schema.Union([
  Schema.TaggedStruct("ExecutorWelcome", { welcome: WelcomeWire }),
  Schema.TaggedStruct("ExecutorReconnected", { welcome: ReconnectWelcomeWire }),
  Schema.TaggedStruct("LeaseReceipt", { receipt: ReceiptWire }),
  Schema.TaggedStruct("CheckpointAccepted", { checkpointId: Identifier, contentDigest: Sha256 }),
  Schema.TaggedStruct("CheckoutCredential", { credential: CredentialWire }),
  Schema.TaggedStruct("PtyCreate", { fence: Fence, request: PtyCreate }),
  Schema.TaggedStruct("PtyInput", { fence: Fence, request: PtyInput }),
  Schema.TaggedStruct("PtyResize", { fence: Fence, request: PtyResize }),
  Schema.TaggedStruct("PtyDisconnect", { fence: Fence, ptyId: Identifier }),
  Schema.TaggedStruct("PtyReconnect", { fence: Fence, request: PtyReconnect }),
  Schema.TaggedStruct("Fenced", { fence: Fence, message: Schema.String }),
])
export type ControllerMessage = typeof ControllerMessage.Type

export class ProtocolError extends Schema.TaggedError<ProtocolError>()("ProtocolError", {
  kind: Schema.Literals(["authentication", "cursor", "fenced", "phase", "protocol"]),
  message: Schema.String,
}) {}
