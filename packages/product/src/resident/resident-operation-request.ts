import { Schema } from "effect"
import { Input } from "../operation/contract/product-operation"
import { OperationUnavailable } from "../operation/contract/product-operation-service"

const Ping = Schema.Struct({ _tag: Schema.tag("ping"), id: Schema.String })
const Pong = Schema.Struct({ _tag: Schema.tag("pong"), id: Schema.String })
const OperationRequest = Schema.Struct({
  _tag: Schema.tag("operation"),
  requestId: Schema.String,
  input: Input,
})
const CancelRequest = Schema.Struct({ _tag: Schema.tag("cancel"), requestId: Schema.String })
const Output = Schema.Struct({
  _tag: Schema.tag("output"),
  requestId: Schema.String,
  channel: Schema.Literals(["stdout", "stderr"]),
  text: Schema.String,
})
const OperationCompleted = Schema.Struct({ _tag: Schema.tag("operation-completed"), requestId: Schema.String })
const OperationFailed = Schema.Struct({
  _tag: Schema.tag("operation-failed"),
  requestId: Schema.String,
  error: OperationUnavailable,
})

export { OperationRequest }

export const OperationRequestProtocol = {
  Ping,
  Pong,
  OperationRequest,
  CancelRequest,
  Output,
  OperationCompleted,
  OperationFailed,
} as const
