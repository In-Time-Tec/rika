import { Schema } from "effect"
import * as Selection from "./agent-tool-selection"
import * as Tools from "./agent-tool-tools"
import * as Toolkits from "./agent-tool-toolkits"
import * as Registrations from "./agent-tool-registrations"
import * as Await from "./agent-tool-await-result"
import * as Outcomes from "./agent-tool-outcomes"
import * as Errors from "./agent-tool-errors"
import * as ResultContent from "./agent-tool-content"
export const TaskInput = Schema.Struct({
  prompt: Schema.String,
})
export type TaskInput = typeof TaskInput.Type

export const ReadThreadInput = Schema.Struct({
  prompt: Schema.String,
  threadId: Schema.optionalKey(Schema.String),
})
export type ReadThreadInput = typeof ReadThreadInput.Type

const Spawned = Schema.Struct({
  _tag: Schema.tag("Spawned"),
  childExecutionId: Schema.String,
  status: Schema.Literal("running"),
  next: Schema.String,
})
type Spawned = typeof Spawned.Type

const spawnedNext =
  "The subagent is running in the background. Start any other independent work now, then call await_subagents to collect its report. Never answer the user before every subagent you started has been collected."

const spawned = ({ childExecutionId }: Pick<Spawned, "childExecutionId">): Spawned => ({
  _tag: "Spawned",
  childExecutionId,
  status: "running",
  next: spawnedNext,
})

const awaitSubagentsToolName = Selection.awaitSubagentsToolName
const awaitSubagentsDescription = Selection.awaitSubagentsDescription
const awaitSubagentsTool = Selection.awaitSubagentsTool
const delegationToolNames = Selection.delegationToolNames
export type DelegationToolName = Selection.DelegationToolName
const isDelegationToolName = Selection.isDelegationToolName
const isSubagentToolName = Selection.isSubagentToolName
const AwaitSubagentsInput = Tools.AwaitSubagentsInput
const taskTool = Tools.taskTool
const oracleTool = Tools.oracleTool
const librarianTool = Tools.librarianTool
const reviewTool = Tools.reviewTool
const surgeonTool = Tools.surgeonTool
const readThreadTool = Tools.readThreadTool
const modelToolkit = Toolkits.modelToolkit
const joinToolkit = Toolkits.joinToolkit
const registrations = Registrations.registrations
const Result = Await.Result
export type Result = typeof Result.Type
const Content = ResultContent.Content
export type Content = typeof Content.Type
const AwaitSubagentsResult = Await.AwaitSubagentsResult
const noReportRecovery = Outcomes.noReportRecovery
const report = Outcomes.report
const noReport = Outcomes.noReport
const failed = Outcomes.failed
const cancelled = Outcomes.cancelled
const AgentToolError = Errors.AgentToolError

export const AgentContract = {
  TaskInput,
  ReadThreadInput,
  Spawned,
  spawnedNext,
  spawned,
  awaitSubagentsToolName,
  awaitSubagentsDescription,
  awaitSubagentsTool,
  delegationToolNames,
  isDelegationToolName,
  isSubagentToolName,
  AwaitSubagentsInput,
  taskTool,
  oracleTool,
  librarianTool,
  reviewTool,
  surgeonTool,
  readThreadTool,
  modelToolkit,
  joinToolkit,
  registrations,
  Result,
  Content,
  AwaitSubagentsResult,
  noReportRecovery,
  report,
  noReport,
  failed,
  cancelled,
  AgentToolError,
}
