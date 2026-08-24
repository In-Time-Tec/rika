import type * as TranscriptUnit from "@rika/transcript/transcript-unit"
import type * as TranscriptPresentationModel from "@rika/transcript/transcript-presentation-model"

export type TranscriptBlock = TranscriptPresentationModel.Block

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
