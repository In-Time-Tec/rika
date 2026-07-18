import { Schema } from "effect"
import { Tool, Toolkit } from "effect/unstable/ai"

const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0))

export const Result = Schema.Struct({
  text: Schema.String,
  truncated: Schema.Boolean,
})
export type Result = typeof Result.Type

export class ToolError extends Schema.TaggedErrorClass<ToolError>()("ThreadToolError", {
  tool: Schema.String,
  message: Schema.String,
}) {}

const ToolFailure = Schema.Struct({
  _tag: Schema.tag("ThreadToolError"),
  tool: Schema.String,
  message: Schema.String,
})

export const FindThreadInput = Schema.Struct({
  query: Schema.String,
  includeArchived: Schema.optionalKey(Schema.Boolean),
  limit: Schema.optionalKey(PositiveInt),
})

export const ReadThreadInput = Schema.Struct({
  threadId: Schema.String,
  includeArchived: Schema.optionalKey(Schema.Boolean),
  maxTurns: Schema.optionalKey(PositiveInt),
  maxChars: Schema.optionalKey(PositiveInt),
})

export const findThreadTool = Tool.make("find_thread", {
  description:
    "Find local Rika threads by bounded metadata query terms. Supports plain text and workspace:, repo:, ref:, author:, label:, file:, after:, and before: terms.",
  parameters: FindThreadInput,
  success: Result,
  failure: ToolFailure,
  failureMode: "return",
})

export const readThreadTool = Tool.make("read_thread", {
  description: "Read a bounded deterministic transcript for one local Rika thread by id",
  parameters: ReadThreadInput,
  success: Result,
  failure: ToolFailure,
  failureMode: "return",
})

export const toolkit = Toolkit.make(findThreadTool, readThreadTool)
