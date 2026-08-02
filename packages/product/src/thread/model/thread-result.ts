import { Schema } from "effect"
import type { AgentExecutionTurn, RecordedShellTurn as RecordedShellTurnModel, Turn } from "./turn-record"

export const RecordedShellResult = Schema.Struct({
  text: Schema.String,
  truncated: Schema.Boolean,
  exitCode: Schema.optionalKey(Schema.Int),
})
export type RecordedShellResult = typeof RecordedShellResult.Type

export const ExecutionAttachment = Schema.Struct({
  parentExecutionKey: Schema.String,
  parentUnitKey: Schema.String,
  parentId: Schema.String,
  parentOrderKey: Schema.String,
})
export interface ExecutionAttachment extends Schema.Schema.Type<typeof ExecutionAttachment> {}

type RecordedShellTurn = Extract<Turn, { readonly _tag: "RecordedShell" }>
export type RunningRecordedShellTurn = Extract<RecordedShellTurnModel, { readonly status: "running" }>
export type TerminalRecordedShellTurn = Exclude<RecordedShellTurnModel, RunningRecordedShellTurn>

export const TurnResult = {
  isAgentExecution: (turn: Turn): turn is AgentExecutionTurn => turn._tag === "AgentExecution",
  isRecordedShell: (turn: Turn): turn is RecordedShellTurn => turn._tag === "RecordedShell",
  isRunningRecordedShell: (turn: Turn): turn is RunningRecordedShellTurn =>
    turn._tag === "RecordedShell" && turn.status === "running",
  isTerminalRecordedShell: (turn: Turn): turn is TerminalRecordedShellTurn =>
    turn._tag === "RecordedShell" && turn.status !== "running",
  lastCursor: (turn: Turn): string | undefined =>
    turn._tag === "AgentExecution"
      ? (turn as Extract<Turn, { readonly _tag: "AgentExecution" }>).lastCursor
      : undefined,
}
