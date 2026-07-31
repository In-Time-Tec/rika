import { Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import * as Policy from "../tool-policy"
import { Result, ToolFailure } from "./result"
export const Request = Schema.Struct({
  _tag: Schema.tag("Edit"),
  path: Schema.String,
  oldStr: Schema.String,
  newStr: Schema.String,
  replaceAll: Schema.optionalKey(Schema.Boolean),
})
export const tool = Tool.make("edit", {
  description: "Replace exact text in an existing file and return a diff",
  parameters: Schema.Struct({
    path: Schema.String,
    old_str: Schema.String,
    new_str: Schema.String,
    replace_all: Schema.optionalKey(Schema.Boolean),
  }),
  success: Result,
  failure: ToolFailure,
  failureMode: "return",
})
export const registration = Policy.register(
  tool,
  Policy.allow("unsafe", 10_000, 4_000, {
    family: "edit",
    action: "edit",
    activeLabel: "Editing",
    completeLabel: "Edited",
  }),
)
