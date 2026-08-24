import { Schema } from "effect"
import { FailureCategory, Recovery } from "./classification"

export * from "./classification"

export const ToolFailure = Schema.Struct({
  _tag: Schema.tag("ToolError"),
  tool: Schema.String,
  message: Schema.String,
  kind: Schema.Literals(["operation", "timeout"]),
  category: FailureCategory,
  outcome: Schema.Literals(["known", "unknown"]),
  recovery: Recovery,
  nextAction: Schema.String,
})
