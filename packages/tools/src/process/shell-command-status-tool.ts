import { Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import * as Policy from "../policy/coding-tool-policy"
import { Result, ToolFailure } from "../runtime/coding-tool-result"
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
export const Request = Schema.Struct({
  _tag: Schema.tag("ShellCommandStatus"),
  processId: Schema.String,
  waitMillis: Schema.optionalKey(NonNegativeInt),
})
export const tool = Tool.make("shell_command_status", {
  description: "Return only new output from a running command without restarting it",
  parameters: Schema.Struct({
    processId: Schema.String,
    waitMillis: Schema.optionalKey(Schema.NullOr(NonNegativeInt)),
  }),
  success: Result,
  failure: ToolFailure,
  failureMode: "return",
})
export const registration = Policy.register(
  tool,
  Policy.allow("safe", 10_000, 40_000, {
    family: "direct",
    action: "status",
    activeLabel: "Waiting for",
    completeLabel: "Waited for",
    failedLabel: "Command wait failed",
    rowDisplay: "continuation",
  }),
)
