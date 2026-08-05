import { Schema } from "effect"
import { ThreadId } from "./thread-record"

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
