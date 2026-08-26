import { Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import * as Policy from "../../policy/coding-tools"
import { maxOutputBytes, Result, ToolFailure } from "../../runtime/result/value"
export const Request = Schema.Struct({
  _tag: Schema.tag("ReadWebPage"),
  url: Schema.String,
  objective: Schema.optionalKey(Schema.String),
  fullContent: Schema.optionalKey(Schema.Boolean),
  forceRefetch: Schema.optionalKey(Schema.Boolean),
})
export const tool = Tool.make("read_web_page", {
  description:
    "Read a public HTTP(S) page as readable Markdown, optionally selecting objective-relevant excerpts. " +
    "Local paths and file:// URLs are unsupported; use rika.workspace.read or a local-capable child.",
  parameters: Schema.Struct({
    url: Schema.String,
    objective: Schema.optionalKey(Schema.String),
    fullContent: Schema.optionalKey(Schema.Boolean),
    forceRefetch: Schema.optionalKey(Schema.Boolean),
  }),
  success: Result,
  failure: ToolFailure,
  failureMode: "return",
})
export const registration = Policy.register(
  tool,
  Policy.allow("safe", 30_000, maxOutputBytes, {
    family: "direct",
    action: "read-web-page",
    activeLabel: "Read",
    completeLabel: "Read",
    outputDisplay: "expandable",
    counter: "web page",
  }),
)
