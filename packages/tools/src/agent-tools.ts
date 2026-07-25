import { Schema } from "effect"
import { Tool, Toolkit } from "effect/unstable/ai"
import * as Policy from "./tool-policy"
import * as ToolInvocation from "./tool-invocation"

export const TaskInput = Schema.Struct({
  prompt: Schema.String,
})
export type TaskInput = typeof TaskInput.Type

export const ReadThreadInput = Schema.Struct({
  prompt: Schema.String,
  threadId: Schema.optionalKey(Schema.String),
})
export type ReadThreadInput = typeof ReadThreadInput.Type

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
  status: Schema.Literal("failed"),
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

export const noReportRecovery =
  "Nothing came back, so there is no finding to report or act on. Re-run this delegation once with the same prompt, or do the work yourself. Never present this to the user as the subagent having found nothing."

export const report = ({ childExecutionId, output }: Pick<Report, "childExecutionId" | "output">): Report => ({
  _tag: "Report",
  childExecutionId,
  status: "completed",
  output,
})

export const noReport = ({ childExecutionId, reason }: Pick<NoReport, "childExecutionId" | "reason">): NoReport => ({
  _tag: "NoReport",
  childExecutionId,
  status: "failed",
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

const Failure = Schema.Struct({
  _tag: Schema.tag("AgentToolError"),
  tool: Schema.String,
  message: Schema.String,
})

export const taskDescription =
  "Delegate workspace investigation, codebase exploration, reproductions, or implementation to a durable Task subagent and wait for its result. Independent explorations SHOULD be parallel spawn calls in one turn."

export const taskTool = Tool.make("task", {
  description: taskDescription,
  parameters: TaskInput,
  success: Result,
  failure: Failure,
  failureMode: "return",
}).addDependency(ToolInvocation.ToolInvocation)

const specialist = <const Name extends string>(name: Name, description: string) =>
  Tool.make(name, {
    description,
    parameters: Schema.Struct({ prompt: Schema.String }),
    success: Result,
    failure: Failure,
    failureMode: "return",
  }).addDependency(ToolInvocation.ToolInvocation)

export const oracleTool = specialist(
  "oracle",
  "Delegate high-level planning, architecture tradeoffs, difficult debugging analysis, or critical review of already-gathered evidence to the read-only Oracle product agent; do not use it for primary workspace or codebase exploration",
)
export const librarianTool = specialist(
  "librarian",
  "Delegate substantive external documentation, repository, or codebase research—including access-controlled GitHub-oriented and public semantic-code searches—to the network-read-only Librarian product agent and wait for its result",
)
export const reviewTool = specialist(
  "review",
  "Delegate a focused correctness and regression review to the read-only Review product agent and wait for its result",
)
export const surgeonTool = specialist(
  "surgeon",
  "Delegate reproducing and isolating a specific defect to the Surgeon product agent, which may run commands and add temporary instrumentation, and wait for its diagnosis",
)
export const readThreadTool = Tool.make("read_thread", {
  description:
    "Ask the ReadThread agent a focused question about one Rika Thread, or let it find relevant Threads when threadId is omitted",
  parameters: ReadThreadInput,
  success: Result,
  failure: Failure,
  failureMode: "return",
}).addDependency(ToolInvocation.ToolInvocation)

export const delegationToolNames = ["task", "oracle", "librarian", "review", "surgeon", "read_thread"] as const
export type DelegationToolName = (typeof delegationToolNames)[number]
export const isDelegationToolName = (name: string): name is DelegationToolName =>
  delegationToolNames.includes(name as DelegationToolName)

export const modelToolkit = Toolkit.make(taskTool, oracleTool, librarianTool, reviewTool, surgeonTool, readThreadTool)

export const registrations: ReadonlyArray<Policy.Registration> = [
  Policy.register(
    taskTool,
    Policy.allow("unsafe", 120_000, 40_000, {
      family: "agent",
      action: "task",
      activeLabel: "Subagent working",
      completeLabel: "Subagent finished",
    }),
  ),
  Policy.register(
    oracleTool,
    Policy.allow("unsafe", 120_000, 40_000, {
      family: "agent",
      action: "oracle",
      activeLabel: "Oracle exploring",
      completeLabel: "Oracle has spoken",
    }),
  ),
  Policy.register(
    librarianTool,
    Policy.allow("unsafe", 120_000, 40_000, {
      family: "agent",
      action: "librarian",
      activeLabel: "Librarian researching",
      completeLabel: "Librarian researched",
    }),
  ),
  Policy.register(
    reviewTool,
    Policy.allow("unsafe", 120_000, 40_000, {
      family: "agent",
      action: "review",
      activeLabel: "Reviewing code",
      completeLabel: "Reviewed code",
      counter: "review",
    }),
  ),
  Policy.register(
    surgeonTool,
    Policy.allow("unsafe", 120_000, 40_000, {
      family: "agent",
      action: "surgeon",
      activeLabel: "Surgeon operating",
      completeLabel: "Surgeon closed up",
    }),
  ),
  Policy.register(
    readThreadTool,
    Policy.allow("unsafe", 120_000, 40_000, {
      family: "agent",
      action: "read-thread",
      activeLabel: "Reading Thread",
      completeLabel: "Read Thread",
      counter: "thread",
    }),
  ),
]
