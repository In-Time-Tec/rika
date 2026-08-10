import { Schema } from "effect"

export const RunStatus = Schema.Literals([
  "pending",
  "running",
  "waiting",
  "cancelling",
  "succeeded",
  "failed",
  "cancelled",
])

const ChildOrigin = Schema.Struct({ operationKey: Schema.String, ordinal: Schema.Int })

export const ChildInspection = Schema.Struct({
  childRunId: Schema.String,
  status: RunStatus,
  invocationId: Schema.optionalKey(Schema.String),
  origin: Schema.optionalKey(ChildOrigin),
  outcome: Schema.optionalKey(Schema.Unknown),
  lastActivityAt: Schema.optionalKey(Schema.String),
  latestStep: Schema.optionalKey(Schema.String),
})

export const AdmitReceipt = Schema.Struct({
  childRunId: Schema.String,
  key: Schema.String,
  duplicate: Schema.Boolean,
})

export const MessageReceipt = Schema.Struct({
  messageId: Schema.String,
  entryId: Schema.optionalKey(Schema.String),
  duplicate: Schema.Boolean,
})

export const MessageInboxEntry = Schema.TaggedStruct("Message", {
  entryId: Schema.String,
  sequence: Schema.Int,
  from: Schema.String,
  prompt: Schema.String,
  messageId: Schema.String,
  correlationId: Schema.optionalKey(Schema.String),
  inReplyTo: Schema.optionalKey(Schema.String),
})

export const ChildSettlementInboxEntry = Schema.TaggedStruct("ChildSettlement", {
  notificationId: Schema.String,
  parentRunId: Schema.String,
  childRunId: Schema.String,
  terminalEventId: Schema.String,
  status: Schema.Literals(["succeeded", "failed", "cancelled"]),
  resultText: Schema.String,
  resultBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  resultTruncated: Schema.Boolean,
  sequence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  admittedAtMillis: Schema.Finite,
  resultArtifact: Schema.optionalKey(Schema.Struct({ id: Schema.String, bytes: Schema.Int })),
})

export const InboxEntry = Schema.Union([MessageInboxEntry, ChildSettlementInboxEntry])

export const DirectoryEntry = Schema.Struct({
  address: Schema.String,
  runId: Schema.String,
  sessionId: Schema.String,
  name: Schema.optionalKey(Schema.String),
  relationship: Schema.Literals(["self", "parent", "child", "sibling", "policy"]),
})
