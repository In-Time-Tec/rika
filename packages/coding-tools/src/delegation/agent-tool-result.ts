import { Schema } from "effect"

export const Report = Schema.Struct({
  _tag: Schema.tag("Report"),
  childExecutionId: Schema.String,
  status: Schema.Literal("completed"),
  output: Schema.NonEmptyArray(Schema.Unknown),
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
  output: Schema.NonEmptyArray(Schema.Unknown),
})
export type Failed = typeof Failed.Type

export const Cancelled = Schema.Struct({
  _tag: Schema.tag("Cancelled"),
  childExecutionId: Schema.String,
  status: Schema.Literal("cancelled"),
  reason: Schema.String,
  output: Schema.Array(Schema.Unknown),
})
export type Cancelled = typeof Cancelled.Type
