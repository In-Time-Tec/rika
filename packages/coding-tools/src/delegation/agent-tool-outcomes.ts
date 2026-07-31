import type { Report, NoReport, Failed, Cancelled } from "./agent-tool-result"

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
