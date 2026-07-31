import { Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import * as ToolInvocation from "../catalog/tool-invocation"
import { TaskInput, ReadThreadInput, Spawned } from "./agent-tool-contract"

export const AwaitSubagentsInput = Schema.Struct({
  subagents: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
})
export type AwaitSubagentsInput = typeof AwaitSubagentsInput.Type

const Failure = Schema.Struct({
  _tag: Schema.tag("AgentToolError"),
  tool: Schema.String,
  message: Schema.String,
})

const taskDescription =
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
