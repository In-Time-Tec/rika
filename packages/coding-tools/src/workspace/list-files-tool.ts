import { Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import * as Policy from "../policy/coding-tool-policy"
import { maxOutputBytes, Result, ToolFailure } from "../runtime/coding-tool-result"

export const maximumDepth = 8

const Depth = Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(maximumDepth))

export const Request = Schema.Struct({
  _tag: Schema.tag("List"),
  path: Schema.optionalKey(Schema.String),
  depth: Schema.optionalKey(Depth),
})

export const tool = Tool.make("list", {
  description:
    "List workspace file and directory names as a bounded tree. It returns { text: string, entries: [{ name, kind, entries? }], truncated: boolean }; truncated is true when the requested depth or the entry cap hid descendants. Use list for filenames; grep searches file contents.",
  parameters: Schema.Struct({
    path: Schema.optionalKey(Schema.String),
    depth: Schema.optionalKey(Depth),
  }),
  success: Result,
  failure: ToolFailure,
  failureMode: "return",
})

export const registration = Policy.register(
  tool,
  Policy.allow("safe", 10_000, maxOutputBytes, {
    family: "explore",
    action: "list",
    activeLabel: "Exploring",
    completeLabel: "Explored",
    counter: "file",
  }),
)
