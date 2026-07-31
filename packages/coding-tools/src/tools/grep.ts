import { Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import * as Policy from "../tool-policy"
import { Result, ToolFailure } from "./result"
export const Request = Schema.Struct({ _tag: Schema.tag("Grep"), pattern: Schema.String, regex: Schema.Boolean })
export const tool = Tool.make("grep", {
  description: "Search UTF-8 workspace files for text or a regular expression",
  parameters: Schema.Struct({ pattern: Schema.String, regex: Schema.Boolean }),
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
