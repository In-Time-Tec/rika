import { Schema } from "effect"

export const TurnAuthor = Schema.TaggedStruct("Human", {})
export type TurnAuthor = typeof TurnAuthor.Type

export const TurnLineage = Schema.TaggedStruct("Original", {})
export type TurnLineage = typeof TurnLineage.Type
