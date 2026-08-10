import { Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import * as Policy from "../policy/coding-tool-policy"
import { maxOutputBytes, Result, ToolFailure } from "../runtime/coding-tool-result"
export const statusWaitMaximumMillis = 10_000
const WaitMillis = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(statusWaitMaximumMillis),
).annotate({
  description: `Wait from 0 to ${statusWaitMaximumMillis} ms; repeat bounded polls using elapsedMillis instead of one blind long wait`,
})
export const Request = Schema.Struct({
  _tag: Schema.tag("ShellCommandStatus"),
  processId: Schema.String,
  waitMillis: Schema.optionalKey(WaitMillis),
})
export const tool = Tool.make("shell_command_status", {
  description:
    "Return new output and elapsedMillis, waiting at most 10000 ms; completed output is readable exactly once",
  parameters: Schema.Struct({
    processId: Schema.String,
    waitMillis: Schema.optionalKey(Schema.NullOr(WaitMillis)),
  }),
  success: Result,
  failure: ToolFailure,
  failureMode: "return",
})
export const registration = Policy.register(
  tool,
  Policy.allow("safe", 15_000, maxOutputBytes, {
    family: "direct",
    action: "status",
    activeLabel: "Waiting for",
    completeLabel: "Waited for",
    failedLabel: "Command wait failed",
    rowDisplay: "continuation",
  }),
)
