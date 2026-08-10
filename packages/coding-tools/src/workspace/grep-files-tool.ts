import { Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import * as Policy from "../policy/coding-tool-policy"
import { Result, ToolFailure } from "../runtime/coding-tool-result"
export const Request = Schema.Struct({
  _tag: Schema.tag("Grep"),
  pattern: Schema.String,
  regex: Schema.Boolean,
  path: Schema.optionalKey(Schema.String),
})
export const tool = Tool.make("grep", {
  description:
    "Search UTF-8 workspace files for text or a regular expression. Scope the search with the optional path glob, for example path: 'packages/foo/**' or path: 'src/a.ts'; do not embed file: filters in the pattern",
  parameters: Schema.Struct({
    pattern: Schema.String,
    regex: Schema.Boolean,
    path: Schema.optionalKey(Schema.String),
  }),
  success: Result,
  failure: ToolFailure,
  failureMode: "return",
})
export const registration = Policy.register(
  tool,
  Policy.allow("safe", 10_000, 40_000, {
    family: "explore",
    action: "grep",
    activeLabel: "Exploring",
    completeLabel: "Explored",
    counter: "search",
  }),
)
