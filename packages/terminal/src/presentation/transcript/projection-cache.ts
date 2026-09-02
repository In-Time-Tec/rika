import { Block } from "@rika/transcript/transcript-presentation-model"
import { UnitOrder } from "@rika/transcript/transcript-unit"
import { Schema } from "effect"
import type { TranscriptItem } from "../../state/transcript/model"

const TranscriptItemSchema = Schema.Union([
  Schema.TaggedStruct("Entry", {
    index: Schema.Finite,
    id: Schema.optionalKey(Schema.String),
    turnId: Schema.optionalKey(Schema.String),
    rootTurnId: Schema.optionalKey(Schema.String),
    parentId: Schema.optionalKey(Schema.String),
    order: Schema.optionalKey(UnitOrder),
  }),
  Schema.TaggedStruct("Block", {
    index: Schema.Finite,
    id: Schema.optionalKey(Schema.String),
    turnId: Schema.optionalKey(Schema.String),
    rootTurnId: Schema.optionalKey(Schema.String),
    parentId: Schema.optionalKey(Schema.String),
    order: Schema.optionalKey(UnitOrder),
  }),
])

export const isBlock = Schema.is(Block)
export const isTranscriptItem = Schema.is(TranscriptItemSchema)

const validBlocksCache = new WeakMap<ReadonlyArray<unknown>, ReadonlyArray<Block>>()
const validItemsCache = new WeakMap<ReadonlyArray<unknown>, ReadonlyArray<TranscriptItem>>()
const knownIndexCache = new WeakMap<ReadonlyArray<unknown>, Map<string, number>>()

export const validBlocks = (source: ReadonlyArray<unknown>): ReadonlyArray<Block> => {
  const cached = validBlocksCache.get(source)
  if (cached !== undefined) return cached
  const valid = source.every(isBlock) ? source : source.filter(isBlock)
  validBlocksCache.set(source, valid)
  return valid
}

export const validItems = (source: ReadonlyArray<unknown>): ReadonlyArray<TranscriptItem> => {
  const cached = validItemsCache.get(source)
  if (cached !== undefined) return cached
  const valid = source.every(isTranscriptItem) ? source : source.filter(isTranscriptItem)
  validItemsCache.set(source, valid)
  return valid
}

export const knownIndexesFor = (items: ReadonlyArray<TranscriptItem>): Map<string, number> => {
  const cached = knownIndexCache.get(items)
  if (cached !== undefined) return cached
  const built = new Map<string, number>()
  for (const [index, item] of items.entries()) if (item.id !== undefined) built.set(item.id, index)
  knownIndexCache.set(items, built)
  return built
}

export const ProjectionIndexCache = {
  set(items: ReadonlyArray<TranscriptItem>, indexes: Map<string, number>): void {
    knownIndexCache.set(items, indexes)
  },
}

let copiedTranscriptBytes = 0
let fullTranscriptArrayCopies = 0

export const recordArrayCopy = (length: number): void => {
  if (length === 0) return
  fullTranscriptArrayCopies += 1
  copiedTranscriptBytes += length * 8
}

export const transcriptProjectionDiagnostics = () => ({ copiedTranscriptBytes, fullTranscriptArrayCopies })

export const resetTranscriptProjectionDiagnostics = (): void => {
  copiedTranscriptBytes = 0
  fullTranscriptArrayCopies = 0
}
