import { Redacted, Schema } from "effect"

const Identifier = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512))
const Generation = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
const Sequence = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const Timestamp = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const ByteLength = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
const Dimension = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(10_000))
const Sha256 = Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/))

export const ProtocolVersion = Schema.Literal(1)
export type ProtocolVersion = typeof ProtocolVersion.Type

export const ExecutorTarget = Schema.Literals(["local_device", "e2b"])
export type ExecutorTarget = typeof ExecutorTarget.Type

export const ExecutorCursor = Schema.Struct({
  sequence: Sequence,
  value: Schema.String,
})
export type ExecutorCursor = typeof ExecutorCursor.Type

export const EmptyExecutorCursor: ExecutorCursor = { sequence: 0, value: "" }

export const ExecutorFence = Schema.Struct({
  target: ExecutorTarget,
  assignmentId: Identifier,
  generation: Generation,
  instanceId: Identifier,
  executorId: Identifier,
})
export type ExecutorFence = typeof ExecutorFence.Type

export const ExecutorHelloWire = Schema.Struct({
  version: ProtocolVersion,
  fence: ExecutorFence,
  bootstrapToken: Identifier,
})
export type ExecutorHelloWire = typeof ExecutorHelloWire.Type

export interface ExecutorHello extends Omit<ExecutorHelloWire, "bootstrapToken"> {
  readonly bootstrapToken: Redacted.Redacted<string>
}

export const redactExecutorHello = (hello: ExecutorHelloWire): ExecutorHello => ({
  ...hello,
  bootstrapToken: Redacted.make(hello.bootstrapToken, { label: "executor-bootstrap" }),
})

export const ExecutorAccessWire = Schema.Struct({
  version: ProtocolVersion,
  fence: ExecutorFence,
  sessionToken: Identifier,
})
export type ExecutorAccessWire = typeof ExecutorAccessWire.Type

export interface ExecutorAccess extends Omit<ExecutorAccessWire, "sessionToken"> {
  readonly sessionToken: Redacted.Redacted<string>
}

export const redactExecutorAccess = (access: ExecutorAccessWire): ExecutorAccess => ({
  ...access,
  sessionToken: Redacted.make(access.sessionToken, { label: "executor-session" }),
})

export const ExecutorHeartbeatWire = Schema.Struct({
  version: ProtocolVersion,
  access: ExecutorAccessWire,
  cursor: ExecutorCursor,
})
export type ExecutorHeartbeatWire = typeof ExecutorHeartbeatWire.Type

export interface ExecutorHeartbeat extends Omit<ExecutorHeartbeatWire, "access"> {
  readonly access: ExecutorAccess
}

export const redactExecutorHeartbeat = (heartbeat: ExecutorHeartbeatWire): ExecutorHeartbeat => ({
  ...heartbeat,
  access: redactExecutorAccess(heartbeat.access),
})

export const FilesystemCheckpoint = Schema.Struct({
  version: ProtocolVersion,
  checkpointId: Identifier,
  objectKey: Identifier,
  contentDigest: Sha256,
  sizeBytes: ByteLength,
  format: Schema.Literal("tar.zst"),
  cursor: ExecutorCursor,
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

export const ExecutorWelcomeWire = Schema.Struct({
  version: ProtocolVersion,
  fence: ExecutorFence,
  sessionToken: Identifier,
  leaseExpiresAt: Timestamp,
  heartbeatIntervalMillis: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  cursor: ExecutorCursor,
})
export type ExecutorWelcomeWire = typeof ExecutorWelcomeWire.Type

export const ExecutorReconnectWelcomeWire = Schema.Struct({
  version: ProtocolVersion,
  fence: ExecutorFence,
  leaseExpiresAt: Timestamp,
  heartbeatIntervalMillis: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  cursor: ExecutorCursor,
})
export type ExecutorReconnectWelcomeWire = typeof ExecutorReconnectWelcomeWire.Type

export const LeaseReceiptWire = Schema.Struct({
  version: ProtocolVersion,
  fence: ExecutorFence,
  leaseExpiresAt: Timestamp,
  cursor: ExecutorCursor,
})
export type LeaseReceiptWire = typeof LeaseReceiptWire.Type

export const ExecutorSessionWire = Schema.Struct({
  version: ProtocolVersion,
  fence: ExecutorFence,
  sessionToken: Identifier,
  heartbeatIntervalMillis: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  cursor: ExecutorCursor,
})
export type ExecutorSessionWire = typeof ExecutorSessionWire.Type

export const CheckoutCredentialWire = Schema.Struct({
  requestId: Identifier,
  repositoryUrl: Identifier,
  username: Schema.Literal("x-access-token"),
  token: Identifier,
  expiresAt: Timestamp,
})

export const ExecutorHostMessage = Schema.Union([
  Schema.TaggedStruct("ExecutorHello", { hello: ExecutorHelloWire }),
  Schema.TaggedStruct("ExecutorReconnect", { access: ExecutorAccessWire }),
  Schema.TaggedStruct("ExecutorHeartbeat", { heartbeat: ExecutorHeartbeatWire }),
  Schema.TaggedStruct("CheckpointStaged", { access: ExecutorAccessWire, checkpoint: FilesystemCheckpoint }),
  Schema.TaggedStruct("CheckoutRequested", { requestId: Identifier, access: ExecutorAccessWire }),
  Schema.TaggedStruct("PtyOpened", { access: ExecutorAccessWire, pty: PtyCreate }),
  Schema.TaggedStruct("PtyOutput", { access: ExecutorAccessWire, ptyId: Identifier, chunk: PtyTranscriptChunk }),
  Schema.TaggedStruct("PtyDisconnected", { access: ExecutorAccessWire, ptyId: Identifier, cursor: Sequence }),
])
export type ExecutorHostMessage = typeof ExecutorHostMessage.Type

export const ExecutorControllerMessage = Schema.Union([
  Schema.TaggedStruct("ExecutorWelcome", { welcome: ExecutorWelcomeWire }),
  Schema.TaggedStruct("ExecutorReconnected", { welcome: ExecutorReconnectWelcomeWire }),
  Schema.TaggedStruct("LeaseReceipt", { receipt: LeaseReceiptWire }),
  Schema.TaggedStruct("CheckpointAccepted", { checkpointId: Identifier, contentDigest: Sha256 }),
  Schema.TaggedStruct("CheckoutCredential", { credential: CheckoutCredentialWire }),
  Schema.TaggedStruct("PtyCreate", { fence: ExecutorFence, request: PtyCreate }),
  Schema.TaggedStruct("PtyInput", { fence: ExecutorFence, request: PtyInput }),
  Schema.TaggedStruct("PtyResize", { fence: ExecutorFence, request: PtyResize }),
  Schema.TaggedStruct("PtyDisconnect", { fence: ExecutorFence, ptyId: Identifier }),
  Schema.TaggedStruct("PtyReconnect", { fence: ExecutorFence, request: PtyReconnect }),
  Schema.TaggedStruct("Fenced", { fence: ExecutorFence, message: Schema.String }),
])
export type ExecutorControllerMessage = typeof ExecutorControllerMessage.Type

export class ExecutorProtocolError extends Schema.TaggedError<ExecutorProtocolError>()("ExecutorProtocolError", {
  kind: Schema.Literals(["authentication", "cursor", "fenced", "phase", "protocol"]),
  message: Schema.String,
}) {}
