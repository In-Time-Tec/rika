import { Function } from "effect"
import type { Model } from "../model"
import type { TranscriptItem } from "./model"
import { decodeTranscriptBlocks, decodeTranscriptItems } from "./model"

export const maxInMemoryTranscriptUnits = 20_000

export const trimTranscriptTimeline: {
  (cap: number): (model: Model) => Model
  (model: Model, cap: number): Model
} = Function.dual(2, (model: Model, cap: number): Model => {
  const items = decodeTranscriptItems(model.items)
  if (items.length <= cap) return model
  const blocks = decodeTranscriptBlocks(model.blocks)
  const byBlockId = new Map<string, number>()
  const identity = (item: TranscriptItem, id: string) => `${item.turnId ?? ""}\0${id}`
  items.forEach((item, position) => {
    if (item._tag === "Block") {
      const block = blocks[item.index]!
      if ("id" in block) byBlockId.set(identity(item, block.id), position)
    }
  })
  const kept = new Set<number>()
  const ancestry = (index: number): Set<number> | undefined => {
    const needed = new Set<number>()
    let position: number | undefined = index
    while (position !== undefined && !kept.has(position)) {
      if (needed.has(position)) return undefined
      needed.add(position)
      const item: TranscriptItem = items[position]!
      position = item.parentId === undefined ? undefined : byBlockId.get(identity(item, item.parentId))
      if (item.parentId !== undefined && position === undefined) return undefined
    }
    return needed
  }
  for (let index = items.length - 1; index >= 0; index--) {
    if (kept.has(index)) continue
    const needed = ancestry(index)
    if (needed !== undefined && kept.size + needed.size <= cap) for (const candidate of needed) kept.add(candidate)
  }
  const keptItems = items.filter((_, index) => kept.has(index))
  const entryIndices = new Map<number, number>()
  const blockIndices = new Map<number, number>()
  const entries: Array<Model["entries"][number]> = []
  const keptBlocks: Array<Model["blocks"][number]> = []
  const remapped: Array<TranscriptItem> = []
  for (const item of keptItems) {
    if (item._tag === "Entry") {
      let index = entryIndices.get(item.index)
      if (index === undefined) {
        index = entries.length
        entryIndices.set(item.index, index)
        entries.push(model.entries[item.index]!)
      }
      remapped.push({ ...item, index })
      continue
    }
    let index = blockIndices.get(item.index)
    if (index === undefined) {
      index = keptBlocks.length
      blockIndices.set(item.index, index)
      keptBlocks.push(model.blocks[item.index])
    }
    remapped.push({ ...item, index })
  }
  return { ...model, entries, blocks: keptBlocks, items: remapped, transcriptTruncated: true }
})
