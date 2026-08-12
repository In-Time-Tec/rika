import { Schema } from "effect"
import * as Thread from "./thread-record"
import * as Turn from "./turn-record"
import * as ThreadRelationship from "./thread-relationship"

export const ThreadViewPendingTurn = Schema.Struct({
  id: Turn.TurnId,
  prompt: Schema.String,
  delivery: Schema.Literals(["steer", "followUp"]),
  createdAt: Schema.Finite,
})
export type ThreadViewPendingTurn = typeof ThreadViewPendingTurn.Type

const threadViewTurnFields = {
  id: Turn.TurnId,
  threadId: Thread.ThreadId,
  prompt: Schema.String,
  status: Schema.Literals([
    "accepted",
    "queued",
    "running",
    "cancelling",
    "waiting",
    "completed",
    "failed",
    "cancelled",
  ]),
  author: ThreadRelationship.TurnAuthor,
  lineage: ThreadRelationship.TurnLineage,
  createdAt: Schema.Finite,
  updatedAt: Schema.Finite,
} as const

export const ThreadViewTurnRecord = Schema.Union([
  Schema.Struct({ ...threadViewTurnFields, kind: Schema.Literal("agent") }),
  Schema.Struct({
    ...threadViewTurnFields,
    kind: Schema.Literal("shell"),
    command: Schema.NonEmptyString,
    result: Schema.optionalKey(
      Schema.Struct({
        text: Schema.String,
        truncated: Schema.Boolean,
        exitCode: Schema.optionalKey(Schema.Int),
      }),
    ),
  }),
])
export type ThreadViewTurnRecord = typeof ThreadViewTurnRecord.Type

export const turnRecord = (turn: Turn.Turn): ThreadViewTurnRecord => {
  const fields = {
    id: turn.id,
    threadId: turn.threadId,
    prompt: turn.prompt,
    status: turn.status,
    author: turn.author,
    lineage: turn.lineage,
    createdAt: turn.createdAt,
    updatedAt: turn.updatedAt,
  }
  if (turn._tag === "AgentExecution") return { ...fields, kind: "agent" }
  return {
    ...fields,
    kind: "shell",
    command: turn.command,
    ...(turn.status === "running" ? {} : { result: turn.result }),
  }
}
