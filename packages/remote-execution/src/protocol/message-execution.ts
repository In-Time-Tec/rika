import * as CodingToolResult from "@rika/coding-tools/coding-tool-result"
import * as CodingToolRuntime from "@rika/coding-tools/coding-tool-runtime"
import * as McpConfiguration from "@rika/extensions/mcp-configuration"
import * as McpRuntime from "@rika/extensions/mcp-runtime"
import { Schema } from "effect"
import {
  AccessWire,
  BindingManifest,
  Cursor,
  Identifier,
  OperationReplayPolicy,
  OutputText,
  ProtocolVersion,
  Sequence,
  redactAccess,
} from "./message-core"
import type { Access } from "./message-core"

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
