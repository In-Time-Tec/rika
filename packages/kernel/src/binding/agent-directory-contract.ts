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

export const MailboxEntry = Schema.Struct({
  entryId: Schema.String,
  sequence: Schema.Int,
  from: Schema.String,
  prompt: Schema.String,
  messageId: Schema.String,
  correlationId: Schema.optionalKey(Schema.String),
  inReplyTo: Schema.optionalKey(Schema.String),
})

export const DirectoryEntry = Schema.Struct({
  address: Schema.String,
  runId: Schema.String,
  sessionId: Schema.String,
  name: Schema.optionalKey(Schema.String),
  relationship: Schema.Literals(["self", "parent", "child", "sibling", "policy"]),
})
