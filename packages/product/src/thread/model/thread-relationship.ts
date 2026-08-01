import { Schema } from "effect"
import { ThreadId } from "./thread-record"
import type { TurnId } from "./turn-record"

export const TurnAuthor = Schema.Union([
  Schema.TaggedStruct("Human", {}),
  Schema.TaggedStruct("Agent", {
    sourceThreadId: ThreadId,
    sourceRootTurnId: Schema.String,
    threadCreationDepth: Schema.Int,
  }),
])
export type TurnAuthor = typeof TurnAuthor.Type

export const TurnLineage = Schema.Union([
  Schema.TaggedStruct("Original", {}),
  Schema.TaggedStruct("ForkCopy", {
    sourceThreadId: ThreadId,
    sourceTurnId: Schema.String,
  }),
])
export type TurnLineage = typeof TurnLineage.Type

export interface ThreadRelationship {
  readonly kind: "created" | "message" | "reply" | "fork"
  readonly sourceThreadId: ThreadId
  readonly sourceTurnId: TurnId
  readonly targetThreadId: ThreadId
  readonly targetTurnId: TurnId
  readonly createdAt: number
}

export interface RelationshipCursor {
  readonly createdAt: number
  readonly targetTurnId: TurnId
}
