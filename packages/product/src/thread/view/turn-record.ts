import { Schema } from "effect"
import * as Thread from "../model/record"
import * as Turn from "../turn/record"
import * as ThreadRelationship from "../model/relationship"

export const ThreadViewPendingTurn = Schema.Struct({
  id: Turn.TurnId,
  prompt: Schema.String,
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
  const kind: ThreadViewTurnRecord["kind"] = "shell"
  const shell = {
    ...fields,
    kind,
    command: turn.command,
  }
  return turn.status === "running" ? shell : { ...shell, result: turn.result }
}
