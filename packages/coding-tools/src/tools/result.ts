import { Schema } from "effect"
import * as MediaView from "../media-view"

export const Result = Schema.Struct({
  text: Schema.String,
  truncated: Schema.Boolean,
  running: Schema.optionalKey(Schema.Boolean),
  processId: Schema.optionalKey(Schema.String),
  exitCode: Schema.optionalKey(Schema.Finite),
  stdout: Schema.optionalKey(Schema.String),
  stderr: Schema.optionalKey(Schema.String),
  diff: Schema.optionalKey(Schema.String),
  artifact: Schema.optionalKey(MediaView.Artifact),
})
export type Result = typeof Result.Type

export const FailureCategory = Schema.Literals([
  "invalid_input",
  "not_found",
  "conflict",
  "access_denied",
  "dependency_unavailable",
  "rate_limited",
  "timeout",
  "operation",
])
export type FailureCategory = typeof FailureCategory.Type

export const Recovery = Schema.Literals(["never", "after_change", "later"])
export type Recovery = typeof Recovery.Type

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
