import { Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import * as Policy from "../tool-policy"
import { Result, ToolFailure } from "./result"
export const Request = Schema.Struct({ _tag: Schema.tag("Write"), path: Schema.String, content: Schema.String })
export const tool = Tool.make("write", {
  description: "Create or overwrite a UTF-8 file, creating parent directories as needed",
  parameters: Schema.Struct({ path: Schema.String, content: Schema.String }),
  success: Result,
  failure: ToolFailure,
  failureMode: "return",
})
export const registration = Policy.register(
  tool,
  Policy.allow("unsafe", 10_000, 4_000, {
    family: "edit",
    action: "create",
    activeLabel: "Creating",
    completeLabel: "Created",
  }),
)
