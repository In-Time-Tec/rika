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

export const Result = Schema.Union([Report, NoReport, Failed, Cancelled])
export type Result = typeof Result.Type

export const AwaitSubagentsResult = Schema.Struct({
  subagents: Schema.Array(Result),
})
export type AwaitSubagentsResult = typeof AwaitSubagentsResult.Type

export const noReportRecovery =
  "Nothing came back, so there is no finding to report or act on. Re-run this delegation once with the same prompt, or do the work yourself. Never present this to the user as the subagent having found nothing."

export const report = ({ childExecutionId, output }: Pick<Report, "childExecutionId" | "output">): Report => ({
  _tag: "Report",
  childExecutionId,
  status: "completed",
  output,
})

export const noReport = ({
  childExecutionId,
  reason,
  status = "failed",
}: Pick<NoReport, "childExecutionId" | "reason"> & Partial<Pick<NoReport, "status">>): NoReport => ({
  _tag: "NoReport",
  childExecutionId,
  status,
  reason,
  recovery: noReportRecovery,
})

export const failed = ({
  childExecutionId,
  reason,
  output,
}: Pick<Failed, "childExecutionId" | "reason" | "output">): Failed => ({
  _tag: "Failed",
  childExecutionId,
  status: "failed",
  reason,
  output,
})

export const cancelled = ({
  childExecutionId,
  reason,
  output,
}: Pick<Cancelled, "childExecutionId" | "reason" | "output">): Cancelled => ({
  _tag: "Cancelled",
  childExecutionId,
  status: "cancelled",
  reason,
  output,
})

export class AgentToolError extends Schema.TaggedErrorClass<AgentToolError>()("AgentToolError", {
  tool: Schema.String,
  message: Schema.String,
}) {}
