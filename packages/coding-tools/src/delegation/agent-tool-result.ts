import { Schema } from "effect"
import { Content } from "./agent-tool-content"

export const Report = Schema.Struct({
  _tag: Schema.tag("Report"),
  childExecutionId: Schema.String,
  status: Schema.Literal("completed"),
  output: Schema.NonEmptyArray(Content),
})
export type Report = typeof Report.Type

export const NoReport = Schema.Struct({
  _tag: Schema.tag("NoReport"),
  childExecutionId: Schema.String,
  status: Schema.Literals(["completed", "failed"]),
  reason: Schema.String,
  recovery: Schema.String,
})
export type NoReport = typeof NoReport.Type

export const Failed = Schema.Struct({
  _tag: Schema.tag("Failed"),
  childExecutionId: Schema.String,
  status: Schema.Literal("failed"),
  reason: Schema.String,
  output: Schema.NonEmptyArray(Content),
})
export type Failed = typeof Failed.Type

export const Cancelled = Schema.Struct({
  _tag: Schema.tag("Cancelled"),
  childExecutionId: Schema.String,
  status: Schema.Literal("cancelled"),
  reason: Schema.String,
  output: Schema.Array(Content),
})
export type Cancelled = typeof Cancelled.Type
