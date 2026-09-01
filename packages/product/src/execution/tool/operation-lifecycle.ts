import { Schema } from "effect"

const Identifier = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512))
const Sequence = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const OutputText = Schema.String.check(Schema.isMaxLength(16_384))

export const ToolOperationSuccess = Schema.TaggedStruct("Success", { result: Schema.Json })
export type ToolOperationSuccess = typeof ToolOperationSuccess.Type

export const ToolOperationDomainFailure = Schema.TaggedStruct("DomainFailure", { failure: Schema.Json })
export type ToolOperationDomainFailure = typeof ToolOperationDomainFailure.Type

export const ToolOperationSuspend = Schema.TaggedStruct("Suspend", { token: Schema.String })
export type ToolOperationSuspend = typeof ToolOperationSuspend.Type

export const ToolOperationResponse = Schema.Union([
  ToolOperationSuccess,
  ToolOperationDomainFailure,
  ToolOperationSuspend,
])
export type ToolOperationResponse = typeof ToolOperationResponse.Type

export const ToolOperationAttribution = Schema.Struct({
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
export type ToolOperationAttribution = typeof ToolOperationAttribution.Type

export const ToolOperationTerminalOutcome = Schema.Literals(["completed", "failed", "cancelled", "unknown"])
export type ToolOperationTerminalOutcome = typeof ToolOperationTerminalOutcome.Type

export const ToolOperationAccepted = Schema.TaggedStruct("Accepted", {
  attribution: ToolOperationAttribution,
  cursor: Sequence,
})
export type ToolOperationAccepted = typeof ToolOperationAccepted.Type

export const ToolOperationStarted = Schema.TaggedStruct("Started", {
  attribution: ToolOperationAttribution,
  cursor: Sequence,
})
export type ToolOperationStarted = typeof ToolOperationStarted.Type

export const ToolOperationOutput = Schema.TaggedStruct("Output", {
  attribution: ToolOperationAttribution,
  cursor: Sequence,
  stream: Schema.Literals(["stdout", "stderr"]),
  text: OutputText,
  redacted: Schema.Literal(true),
  truncated: Schema.Boolean,
})
export type ToolOperationOutput = typeof ToolOperationOutput.Type

export const ToolOperationTerminal = Schema.TaggedStruct("Terminal", {
  attribution: ToolOperationAttribution,
  cursor: Sequence,
  outcome: ToolOperationTerminalOutcome,
  response: ToolOperationResponse,
})
export type ToolOperationTerminal = typeof ToolOperationTerminal.Type

export const ToolOperationLifecycleFrame = Schema.Union([
  ToolOperationAccepted,
  ToolOperationStarted,
  ToolOperationOutput,
  ToolOperationTerminal,
])
export type ToolOperationLifecycleFrame = typeof ToolOperationLifecycleFrame.Type
