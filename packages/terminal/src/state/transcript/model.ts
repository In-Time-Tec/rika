import { Schema } from "effect"
import * as TranscriptUnit from "@rika/transcript/transcript-unit"
import * as TranscriptPresentationModel from "@rika/transcript/transcript-presentation-model"

export type TranscriptBlock = TranscriptPresentationModel.Block
export const TranscriptBlock = TranscriptPresentationModel.Block

export type TranscriptItem =
  | {
      readonly _tag: "Entry"
      readonly index: number
      readonly id?: string
      readonly turnId?: string
      readonly rootTurnId?: string
      readonly parentId?: string
      readonly order?: TranscriptUnit.UnitOrder
    }
  | {
      readonly _tag: "Block"
      readonly index: number
      readonly id?: string
      readonly turnId?: string
      readonly rootTurnId?: string
      readonly parentId?: string
      readonly order?: TranscriptUnit.UnitOrder
    }

export const TranscriptItem = Schema.Union([
  Schema.TaggedStruct("Entry", {
    index: Schema.Finite,
    id: Schema.optionalKey(Schema.String),
    turnId: Schema.optionalKey(Schema.String),
    rootTurnId: Schema.optionalKey(Schema.String),
    parentId: Schema.optionalKey(Schema.String),
    order: Schema.optionalKey(TranscriptUnit.UnitOrder),
  }),
  Schema.TaggedStruct("Block", {
    index: Schema.Finite,
    id: Schema.optionalKey(Schema.String),
    turnId: Schema.optionalKey(Schema.String),
    rootTurnId: Schema.optionalKey(Schema.String),
    parentId: Schema.optionalKey(Schema.String),
    order: Schema.optionalKey(TranscriptUnit.UnitOrder),
  }),
])

const TranscriptBlocks = Schema.Array(TranscriptBlock)
const TranscriptItems = Schema.Array(TranscriptItem)
export const decodeTranscriptBlocks = (input: ReadonlyArray<unknown>): ReadonlyArray<TranscriptBlock> =>
  Schema.decodeUnknownSync(TranscriptBlocks)(input)
export const decodeTranscriptItems = (input: ReadonlyArray<unknown>): ReadonlyArray<TranscriptItem> =>
  Schema.decodeUnknownSync(TranscriptItems)(input)

export const cancelTranscriptBlocks = (blocks: ReadonlyArray<TranscriptBlock>): ReadonlyArray<TranscriptBlock> =>
  blocks.map((block) => {
    if (
      (block._tag === "ToolCall" ||
        block._tag === "SubagentCard" ||
        block._tag === "Compaction" ||
        block._tag === "Cell") &&
      block.status === "running"
    )
      return { ...block, status: "cancelled" as const }
    return block
  })
