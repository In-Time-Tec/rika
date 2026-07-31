import { Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import * as Policy from "../tool-policy"
import { Result, ToolFailure } from "./result"
export const Request = Schema.Struct({
  _tag: Schema.tag("Read"),
  path: Schema.String,
  readRange: Schema.optionalKey(Schema.Array(Schema.Finite).check(Schema.isLengthBetween(2, 2))),
})
export const tool = Tool.make("read", {
  description: "Read a file with stable line numbers, optionally selecting an inclusive range",
  parameters: Schema.Struct({
    path: Schema.String,
    read_range: Schema.optionalKey(Schema.Array(Schema.Finite).check(Schema.isLengthBetween(2, 2))),
  }),
  success: Result,
  failure: ToolFailure,
  failureMode: "return",
})
export const registration = Policy.register(
  tool,
  Policy.allow("safe", 10_000, 40_000, {
    family: "explore",
    action: "read",
    activeLabel: "Exploring",
    completeLabel: "Explored",
    counter: "file",
  }),
)
