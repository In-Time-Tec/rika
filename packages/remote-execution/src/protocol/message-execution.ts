import * as NativeToolResult from "@rika/product/native-tool-result"
import * as NativeToolRuntime from "@rika/product/native-tool-runtime"
import { Schema } from "effect"
import { AccessWire, Cursor, ProtocolVersion, redactAccess } from "./message-core"
import type { Access } from "./message-core"

export const MachineRequest = Schema.TaggedStruct("NativeTool", { request: NativeToolRuntime.Request })
export type MachineRequest = typeof MachineRequest.Type

const MachineSuccess = Schema.TaggedStruct("NativeTool", { result: NativeToolResult.Result })

const MachineFailure = NativeToolRuntime.ToolError

export const MachineOutcome = Schema.Union([
  Schema.TaggedStruct("Success", { value: MachineSuccess }),
  Schema.TaggedStruct("Failure", { failure: MachineFailure }),
  Schema.TaggedStruct("Cancelled", {}),
  Schema.TaggedStruct("Unknown", { message: Schema.String }),
  Schema.TaggedStruct("Fenced", { message: Schema.String }),
])
export type MachineOutcome = typeof MachineOutcome.Type

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
