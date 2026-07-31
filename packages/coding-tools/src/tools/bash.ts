import { Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import * as Policy from "../tool-policy"
import { Result, ToolFailure } from "./result"
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
export const Request = Schema.Struct({
  _tag: Schema.tag("Bash"),
  command: Schema.String,
  workdir: Schema.optionalKey(Schema.String),
  timeoutMillis: Schema.optionalKey(NonNegativeInt),
})
export const tool = Tool.make("bash", {
  description: "Run a shell command in the workspace and return a process id if it outlives the wait",
  parameters: Schema.Struct({
    command: Schema.String,
    workdir: Schema.optionalKey(Schema.String),
    timeout_ms: Schema.optionalKey(NonNegativeInt),
  }),
  success: Result,
  failure: ToolFailure,
  failureMode: "return",
})
export const registration = Policy.register(
  tool,
  Policy.allow("unsafe", 120_000, 40_000, {
    family: "shell",
    action: "command",
    activeLabel: "Running",
    completeLabel: "Ran",
  }),
)
