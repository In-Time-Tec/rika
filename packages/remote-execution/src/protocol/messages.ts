export * from "./message-core"
export * from "./message-execution"
export * from "./message-workspace"
export * from "./message-envelopes"

import { Schema } from "effect"
import type { ApiMessage } from "./message-envelopes"

export type IncomingMessage = ApiMessage

export class ProtocolError extends Schema.TaggedError<ProtocolError>()("ProtocolError", {
  kind: Schema.Literals(["authentication", "cursor", "fenced", "phase", "protocol"]),
  message: Schema.String,
}) {}
