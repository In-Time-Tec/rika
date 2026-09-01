import { Schema } from "effect"
import { Toolkit, Tool } from "effect/unstable/ai"
import * as Find from "./find-contract"

const ThreadState = Find.ThreadState
const findDefaultLimit = Find.findDefaultLimit
const findMaximumLimit = Find.findMaximumLimit
const FindThreadInput = Find.FindThreadInput
const FindThreadSuccess = Find.FindThreadSuccess
const threadToolContractVersion = 1

const ToolFailure = Schema.Struct({
  _tag: Schema.tag("ThreadToolError"),
  tool: Schema.String,
  code: Schema.Literals(["not_found", "invalid_state", "unavailable", "timeout", "operation"]),
  message: Schema.String.check(Schema.isMaxLength(8_000)),
  retryable: Schema.Boolean,
})

const findThreadTool = Tool.make("find_thread", {
  description: "Find Rika threads by metadata without reading their transcript",
  parameters: Find.FindThreadInput,
  success: Find.FindThreadSuccess,
  failure: ToolFailure,
  failureMode: "return",
})
const findToolkit = Toolkit.make(findThreadTool)
const publicToolkit = findToolkit

export const ThreadContract = {
  threadToolContractVersion,
  ThreadState,
  findDefaultLimit,
  findMaximumLimit,
  FindThreadInput,
  FindThreadSuccess,
  findThreadTool,
  findToolkit,
  publicToolkit,
}
