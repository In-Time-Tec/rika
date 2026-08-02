import { Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import { AwaitSubagentsInput } from "./agent-tool-tools"
import { AwaitSubagentsResult } from "./agent-tool-await-result"

const Failure = Schema.Struct({
  _tag: Schema.tag("AgentToolError"),
  tool: Schema.String,
  message: Schema.String,
})
export const awaitSubagentsToolName = "await_subagents"

export const awaitSubagentsDescription =
  "Collect the reports of subagents started earlier in this turn. Blocks until every requested subagent has finished, then returns each one's report or failure. Call it with no arguments to collect every subagent you started, or pass the childExecutionId values to collect a subset. You must collect every subagent you started before giving your final answer."

export const awaitSubagentsTool = Tool.make(awaitSubagentsToolName, {
  description: awaitSubagentsDescription,
  parameters: AwaitSubagentsInput,
  success: AwaitSubagentsResult,
  failure: Failure,
  failureMode: "return",
})

export const delegationToolNames = ["task", "oracle", "librarian", "review", "surgeon", "read_thread"] as const
export type DelegationToolName = (typeof delegationToolNames)[number]
export const isDelegationToolName = (name: string): name is DelegationToolName =>
  delegationToolNames.includes(name as DelegationToolName)

export const isSubagentToolName = (name: string) => isDelegationToolName(name) || name === awaitSubagentsToolName
