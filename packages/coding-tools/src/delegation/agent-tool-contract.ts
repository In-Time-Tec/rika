import { Schema } from "effect"
import { Tool, Toolkit } from "effect/unstable/ai"
import * as Policy from "../policy/coding-tool-policy"
import * as ToolInvocation from "../catalog/tool-invocation"

export const TaskInput = Schema.Struct({
  prompt: Schema.String,
})
export type TaskInput = typeof TaskInput.Type

export const ReadThreadInput = Schema.Struct({
  prompt: Schema.String,
  threadId: Schema.optionalKey(Schema.String),
})
export type ReadThreadInput = typeof ReadThreadInput.Type

export const Spawned = Schema.Struct({
  _tag: Schema.tag("Spawned"),
  childExecutionId: Schema.String,
  status: Schema.Literal("running"),
  next: Schema.String,
})
export type Spawned = typeof Spawned.Type

export const spawnedNext =
  "The subagent is running in the background. Start any other independent work now, then call await_subagents to collect its report. Never answer the user before every subagent you started has been collected."

export const spawned = ({ childExecutionId }: Pick<Spawned, "childExecutionId">): Spawned => ({
  _tag: "Spawned",
  childExecutionId,
  status: "running",
  next: spawnedNext,
})

export const AwaitSubagentsInput = Schema.Struct({
  subagents: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
})
export type AwaitSubagentsInput = typeof AwaitSubagentsInput.Type

import * as AgentResult from "./agent-tool-result"
export { AgentResult }
export type { Report, NoReport, Failed, Cancelled, Result } from "./agent-tool-result"
export { AgentToolError, AwaitSubagentsResult, noReportRecovery } from "./agent-tool-result"
export { report, noReport, failed, cancelled } from "./agent-tool-result"

const AwaitSubagentsResultSchema = AgentResult.AwaitSubagentsResult

const Failure = Schema.Struct({
  _tag: Schema.tag("AgentToolError"),
  tool: Schema.String,
  message: Schema.String,
})

export const taskDescription =
  "Start a durable Task subagent for workspace investigation, codebase exploration, reproductions, or implementation. Returns immediately while the subagent runs in the background; collect its report with await_subagents. Delegate only when the task has a clear independent outcome and direct work would be materially worse; prefer the smallest useful batch and collect it before deciding whether more delegation is needed."

export const taskTool = Tool.make("task", {
  description: taskDescription,
  parameters: TaskInput,
  success: Spawned,
  failure: Failure,
  failureMode: "return",
}).addDependency(ToolInvocation.ToolInvocation)

const specialist = <const Name extends string>(name: Name, description: string) =>
  Tool.make(name, {
    description,
    parameters: Schema.Struct({ prompt: Schema.String }),
    success: Spawned,
    failure: Failure,
    failureMode: "return",
  }).addDependency(ToolInvocation.ToolInvocation)

export const oracleTool = specialist(
  "oracle",
  "Start the read-only Oracle product agent for high-level planning, architecture tradeoffs, difficult debugging analysis, or critical review of already-gathered evidence; do not use it for primary workspace or codebase exploration. Returns immediately; collect its advice with await_subagents",
)
export const librarianTool = specialist(
  "librarian",
  "Start the network-read-only Librarian product agent for substantive external documentation, repository, or codebase research—including access-controlled GitHub-oriented and public semantic-code searches. Returns immediately; collect its findings with await_subagents",
)
export const reviewTool = specialist(
  "review",
  "Start the read-only Review product agent for a focused correctness and regression review. Returns immediately; collect its review with await_subagents",
)
export const surgeonTool = specialist(
  "surgeon",
  "Start the Surgeon product agent to reproduce and isolate a specific defect, which may run commands and add temporary instrumentation. Returns immediately; collect its diagnosis with await_subagents",
)
export const readThreadTool = Tool.make("read_thread", {
  description:
    "Start the ReadThread agent on a focused question about one Rika Thread, or let it find relevant Threads when threadId is omitted. Returns immediately; collect its answer with await_subagents",
  parameters: ReadThreadInput,
  success: Spawned,
  failure: Failure,
  failureMode: "return",
}).addDependency(ToolInvocation.ToolInvocation)

export const awaitSubagentsToolName = "await_subagents"

export const awaitSubagentsDescription =
  "Collect the reports of subagents started earlier in this turn. Blocks until every requested subagent has finished, then returns each one's report or failure. Call it with no arguments to collect every subagent you started, or pass the childExecutionId values to collect a subset. You must collect every subagent you started before giving your final answer."

export const awaitSubagentsTool = Tool.make(awaitSubagentsToolName, {
  description: awaitSubagentsDescription,
  parameters: AwaitSubagentsInput,
  success: AwaitSubagentsResultSchema,
  failure: Failure,
  failureMode: "return",
})

export const delegationToolNames = ["task", "oracle", "librarian", "review", "surgeon", "read_thread"] as const
export type DelegationToolName = (typeof delegationToolNames)[number]
export const isDelegationToolName = (name: string): name is DelegationToolName =>
  delegationToolNames.includes(name as DelegationToolName)

export const isSubagentToolName = (name: string) => isDelegationToolName(name) || name === awaitSubagentsToolName

export const modelToolkit = Toolkit.make(taskTool, oracleTool, librarianTool, reviewTool, surgeonTool, readThreadTool)

export const joinToolkit = Toolkit.make(awaitSubagentsTool)

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
  Policy.register(
    awaitSubagentsTool,
    Policy.allow("unsafe", 120_000, 40_000, {
      family: "direct",
      action: "await-subagents",
      activeLabel: "Waiting for subagents",
      completeLabel: "Collected subagents",
      failedLabel: "Subagent wait failed",
      rowDisplay: "continuation",
    }),
  ),
]
