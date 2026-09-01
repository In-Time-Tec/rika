import { Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import * as Policy from "./policy"
import { maxOutputBytes, Result, ToolFailure } from "./result"

export const initialWaitMaximumMillis = 60_000
const WaitMillis = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(initialWaitMaximumMillis),
).annotate({
  description: `Initial wait from 0 to ${initialWaitMaximumMillis} ms; use 0 to start in the background`,
})

export const Request = Schema.Struct({
  _tag: Schema.tag("Bash"),
  command: Schema.String,
  workdir: Schema.optionalKey(Schema.String),
  timeoutMillis: Schema.optionalKey(WaitMillis),
})
export type Request = typeof Request.Type

export const tool = Tool.make("bash", {
  description:
    "Run a shell command, waiting at most 60000 ms initially; a running result includes partial output and elapsedMillis for follow-up polling",
  parameters: Schema.Struct({
    command: Schema.String,
    workdir: Schema.optionalKey(Schema.String),
    timeout_ms: Schema.optionalKey(WaitMillis),
  }),
  success: Result,
  failure: ToolFailure,
  failureMode: "return",
})

export const registration = Policy.register(
  tool,
  Policy.allow("unsafe", 120_000, maxOutputBytes, {
    family: "shell",
    action: "command",
    activeLabel: "Running",
    completeLabel: "Ran",
  }),
)
