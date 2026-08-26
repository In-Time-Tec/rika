import { Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import * as Policy from "../policy/coding-tools"
import { maxOutputBytes, Result, ToolFailure } from "../runtime/result/value"
export const Request = Schema.Struct({ _tag: Schema.tag("ViewMedia"), path: Schema.String })
export const tool = Tool.make("view_media", {
  description: "Inspect a workspace image or analyze a PDF, audio, or video file",
  parameters: Schema.Struct({ path: Schema.String }),
  success: Result,
  failure: ToolFailure,
  failureMode: "return",
})
export const registration = Policy.register(
  tool,
  Policy.allow("safe", 30_000, maxOutputBytes, {
    family: "explore",
    action: "media",
    activeLabel: "Exploring",
    completeLabel: "Explored",
    counter: "media file",
  }),
)
