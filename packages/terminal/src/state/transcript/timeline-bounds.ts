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
  const childrenByParent = new Map<string, Array<number>>()
  for (const [position, item] of items.entries())
    if (item.parentId !== undefined) {
      const children = childrenByParent.get(item.parentId) ?? []
      children.push(position)
      childrenByParent.set(item.parentId, children)
    }
  const subtreeSize = (root: number): number => {
    let size = 0
    const stack = [root]
    while (stack.length > 0) {
      const position = stack.pop()!
      size += 1
      const item = items[position]!
      if (item._tag === "Block") {
        const block = blocks[item.index]!
        if ("id" in block) for (const child of childrenByParent.get(block.id) ?? []) stack.push(child)
      }
    }
    return size
  }
  let dropEnd = 0
  let remaining = items.length
  while (dropEnd < items.length && remaining > cap) {
    const root = items[dropEnd]!
    if (root.parentId !== undefined) {
      dropEnd += 1
      remaining -= 1
      continue
    }
    const size = subtreeSize(dropEnd)
    if (remaining - size >= cap) {
      dropEnd += size
      remaining -= size
      continue
    }
    break
  }
  if (dropEnd === 0) return model
  const keptItems = items.slice(dropEnd)
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
  return { ...model, entries, blocks: keptBlocks, items: remapped }
})
