import { Schema } from "effect"
import { Tool, Toolkit } from "effect/unstable/ai"
import * as Policy from "./tool-policy"
import * as ToolInvocation from "./tool-invocation"

export const TaskInput = Schema.Struct({
  prompt: Schema.String,
})
export type TaskInput = typeof TaskInput.Type

export const ReadThreadInput = Schema.Union([
  Schema.Struct({ question: Schema.String, threadId: Schema.optionalKey(Schema.String) }),
  Schema.Struct({ prompt: Schema.String }),
])
export type ReadThreadInput = typeof ReadThreadInput.Type

export const Result = Schema.Struct({
  childExecutionId: Schema.String,
  status: Schema.Literals(["completed", "failed", "cancelled"]),
  output: Schema.Array(Schema.Unknown),
})
export type Result = typeof Result.Type

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
export const readThreadTool = Tool.make("read_thread", {
  description:
    "Ask the ReadThread agent a focused question about one Rika Thread, or let it find relevant Threads when threadId is omitted",
  parameters: ReadThreadInput,
  success: Result,
  failure: Failure,
  failureMode: "return",
}).addDependency(ToolInvocation.ToolInvocation)

export const delegationToolNames = ["task", "oracle", "librarian", "review", "read_thread"] as const
export type DelegationToolName = (typeof delegationToolNames)[number]
export const isDelegationToolName = (name: string): name is DelegationToolName =>
  delegationToolNames.includes(name as DelegationToolName)

export const modelToolkit = Toolkit.make(taskTool, oracleTool, librarianTool, reviewTool, readThreadTool)

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
