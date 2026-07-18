import { Schema } from "effect"
import { Tool, Toolkit } from "effect/unstable/ai"

export const modelGuidance =
  "Use Luna for cheap, fast, easy-to-check work: simple searches, file listing, extraction, classification, summaries, and mechanical edits. Avoid it for deep reasoning or large-context synthesis. Use Terra as the balanced default for normal subagent work: repository exploration, multi-step research, document analysis, and moderate coding. Escalate to Sol when mistakes are costly or the task needs the strongest reasoning and coding: architecture analysis, complex debugging, long-horizon implementation, security work, or adversarial review. Relative token cost: Luna 1x, Terra 2.5x, Sol 5x."

export const Model = Schema.Literals(["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"])
export type Model = typeof Model.Type

export const TaskInput = Schema.Struct({
  prompt: Schema.String,
  model: Schema.optionalKey(Model),
})
export type TaskInput = typeof TaskInput.Type

export const BatchCall = Schema.Struct({
  callId: Schema.String,
  prompt: Schema.String,
  model: Schema.optionalKey(Model),
})
export type BatchCall = typeof BatchCall.Type

export const TaskBatch = Schema.Struct({
  fanOutId: Schema.String,
  calls: Schema.Array(BatchCall),
})
export type TaskBatch = typeof TaskBatch.Type

export const RuntimeTaskInput = Schema.Struct({
  ...TaskInput.fields,
  _batch: Schema.optionalKey(TaskBatch),
})
export type RuntimeTaskInput = typeof RuntimeTaskInput.Type

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

export const taskDescription = `Spawn a durable Task subagent and wait for its result. Omit model to inherit the parent model and effort. Independent explorations SHOULD be parallel spawn calls in one turn. ${modelGuidance}`

export const taskTool = Tool.make("task", {
  description: taskDescription,
  parameters: TaskInput,
  success: Result,
  failure: Failure,
  failureMode: "return",
})

export const runtimeTaskTool = Tool.make("task", {
  description: taskDescription,
  parameters: RuntimeTaskInput,
  success: Result,
  failure: Failure,
  failureMode: "return",
})

const specialist = <const Name extends string>(name: Name, description: string) =>
  Tool.make(name, {
    description,
    parameters: Schema.Struct({ prompt: Schema.String }),
    success: Result,
    failure: Failure,
    failureMode: "return",
  })

export const oracleTool = specialist(
  "oracle",
  "Delegate a focused technical investigation to the read-only Oracle product agent and wait for its result",
)
export const librarianTool = specialist(
  "librarian",
  "Delegate authoritative documentation research to the network-read-only Librarian product agent and wait for its result",
)
export const reviewTool = specialist(
  "review",
  "Delegate a focused correctness and regression review to the read-only Review product agent and wait for its result",
)

export const delegationToolNames = ["task", "oracle", "librarian", "review"] as const
export type DelegationToolName = (typeof delegationToolNames)[number]
export const isDelegationToolName = (name: string): name is DelegationToolName =>
  delegationToolNames.includes(name as DelegationToolName)

export const modelToolkit = Toolkit.make(taskTool, oracleTool, librarianTool, reviewTool)
export const runtimeToolkit = Toolkit.make(runtimeTaskTool, oracleTool, librarianTool, reviewTool)
