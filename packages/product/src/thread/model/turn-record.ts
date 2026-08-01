import { Schema } from "effect"
import { ExecutionRouteSnapshot } from "../../execution/contract/execution-route-snapshot"
import { ExecutionExtensionPin } from "../../execution/contract/execution-workflow"
import { PromptPart } from "../../execution/contract/execution-request"
import { Status } from "../../execution/contract/execution-status"
import { StopIntent } from "./thread-state"
import { ThreadId } from "./thread-record"
import { TurnAuthor, TurnLineage } from "./thread-relationship"
import { RecordedShellResult } from "./thread-result"

export const TurnId = Schema.String.check(Schema.isPattern(/^[\x21-\x7e]+$/)).pipe(Schema.brand("RikaTurnId"))
export type TurnId = typeof TurnId.Type

export const AgentExecutionTurn = Schema.TaggedStruct("AgentExecution", {
  id: TurnId,
  threadId: ThreadId,
  prompt: Schema.String,
  promptParts: Schema.optionalKey(Schema.Array(PromptPart)),
  status: Status,
  stopIntent: StopIntent,
  lastCursor: Schema.optionalKey(Schema.String),
  extensionPin: Schema.optionalKey(ExecutionExtensionPin),
  executionRoute: ExecutionRouteSnapshot,
  reviewFanOutId: Schema.optionalKey(Schema.String),
  author: TurnAuthor,
  lineage: TurnLineage,
  createdAt: Schema.Finite,
  updatedAt: Schema.Finite,
})
export type AgentExecutionTurn = typeof AgentExecutionTurn.Type

const RecordedShellFields = {
  id: TurnId,
  threadId: ThreadId,
  prompt: Schema.String,
  command: Schema.NonEmptyString,
  stopIntent: Schema.Literal("none"),
  author: Schema.TaggedStruct("Human", {}),
  lineage: Schema.TaggedStruct("Original", {}),
  createdAt: Schema.Finite,
  updatedAt: Schema.Finite,
} as const

export const RecordedShellTurn = Schema.Union([
  Schema.TaggedStruct("RecordedShell", {
    ...RecordedShellFields,
    status: Schema.Literal("running"),
  }),
  Schema.TaggedStruct("RecordedShell", {
    ...RecordedShellFields,
    status: Schema.Literals(["completed", "failed", "cancelled"]),
    result: RecordedShellResult,
  }),
])
export type RecordedShellTurn = typeof RecordedShellTurn.Type
export const Turn = Schema.Union([AgentExecutionTurn, RecordedShellTurn])
export type Turn = typeof Turn.Type
