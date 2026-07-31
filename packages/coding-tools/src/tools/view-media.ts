import { Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import * as Policy from "../tool-policy"
import * as MediaView from "../media-view"
import { Result, ToolFailure } from "./result"
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
  Policy.allow("safe", 30_000, 40_000, {
    family: "explore",
    action: "media",
    activeLabel: "Exploring",
    completeLabel: "Explored",
    counter: "media file",
  }),
)
export { MediaView }
