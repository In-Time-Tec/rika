import { Schema } from "effect"
import * as TranscriptUnit from "@rika/transcript/transcript-unit"
import * as TranscriptPresentationModel from "@rika/transcript/transcript-presentation-model"

export type TranscriptBlock = TranscriptPresentationModel.Block
export const TranscriptBlock = TranscriptPresentationModel.Block

export const TranscriptItem = Schema.Union([
  Schema.TaggedStruct("Entry", {
    index: Schema.Finite,
    id: Schema.optionalKey(Schema.String),
    turnId: Schema.optional(Schema.String),
    rootTurnId: Schema.optionalKey(Schema.String),
    parentId: Schema.optional(Schema.String),
    order: Schema.optionalKey(TranscriptUnit.UnitOrder),
    submissionId: Schema.optionalKey(Schema.String),
    provisional: Schema.optionalKey(Schema.Boolean),
  }),
  Schema.TaggedStruct("Block", {
    index: Schema.Finite,
    id: Schema.optionalKey(Schema.String),
    turnId: Schema.optional(Schema.String),
    rootTurnId: Schema.optionalKey(Schema.String),
    parentId: Schema.optional(Schema.String),
    order: Schema.optionalKey(TranscriptUnit.UnitOrder),
  }),
])

export type TranscriptItem = typeof TranscriptItem.Type

export const cancelTranscriptBlocks = (blocks: ReadonlyArray<TranscriptBlock>): ReadonlyArray<TranscriptBlock> =>
  blocks.map((block) => {
    if (
      (block._tag === "ToolCall" || block._tag === "SubagentCard" || block._tag === "Compaction") &&
      block.status === "running"
    )
      return { ...block, status: "cancelled" as const }
    return block
  })
