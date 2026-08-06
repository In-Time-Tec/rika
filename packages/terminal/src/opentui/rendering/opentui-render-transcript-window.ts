import { Function } from "effect"
import type { Model } from "../../state/model/terminal-state"
import type { TranscriptBlock, TranscriptItem } from "../../state/model/terminal-transcript-state"
import type { TextChunk } from "@opentui/core"
import type { PathTarget } from "../../presentation/transcript/transcript-tool-detail-types"
import { spacing } from "../../presentation/terminal/terminal-theme"

export const transcriptWrapWidth = (width: number): number => Math.max(8, width - spacing.transcript * 2 - 2)

export const maxMountedTranscriptEntries = 600

export const maxBoundedTranscriptItems = 1200

export interface UnitLineRange {
  readonly start: number
  readonly end: number
  readonly headerEnd?: number
  readonly unit: string
  readonly expandable: boolean
  readonly animated?: boolean
  readonly gapBefore?: boolean
  readonly targets?: ReadonlyArray<PathTarget>
}

type BoundedTranscriptModel = Omit<Model, "items"> & { readonly items: ReadonlyArray<TranscriptItem> }

export const boundedTranscriptModel: {
  (model: Model): BoundedTranscriptModel
  (model: Model, end: number): BoundedTranscriptModel
  (end: number): (model: Model) => BoundedTranscriptModel
} = Function.dual(
  (args) => typeof args[0] === "object",
  (model: Model, end = model.items.length): BoundedTranscriptModel => {
    const limit = maxMountedTranscriptEntries
    if (model.items.length === 0)
      return {
        ...model,
        entries: model.entries.slice(-limit),
        blocks: model.blocks.slice(-limit),
        items: [],
      }
    const windowEnd = Math.min(model.items.length, Math.max(0, Math.floor(end)))
    if (windowEnd === model.items.length && model.items.length <= limit)
      return { ...model, items: model.items as ReadonlyArray<TranscriptItem> }
    const allItems = model.items as ReadonlyArray<TranscriptItem>
    let hasParent = false
    for (let position = 0; position < windowEnd; position += 1)
      if (allItems[position]?.parentId !== undefined) {
        hasParent = true
        break
      }
    if (!hasParent) {
      const flat = allItems.slice(Math.max(0, windowEnd - limit), windowEnd)
      const entries: Array<Model["entries"][number]> = []
      const blocks: Array<Model["blocks"][number]> = []
      const entryIndices = new Map<number, number>()
      const blockIndices = new Map<number, number>()
      const items: Array<TranscriptItem> = []
      for (const item of flat) {
        if (item._tag === "Entry") {
          let index = entryIndices.get(item.index)
          if (index === undefined) {
            index = entries.length
            entryIndices.set(item.index, index)
            entries.push(model.entries[item.index]!)
          }
          items.push({ ...item, index })
          continue
        }
        let index = blockIndices.get(item.index)
        if (index === undefined) {
          index = blocks.length
          blockIndices.set(item.index, index)
          blocks.push(model.blocks[item.index]!)
        }
        items.push({ ...item, index })
      }
      return { ...model, entries, blocks, items }
    }
    const itemPositionByBlockId = new Map<string, number>()
    for (const [position, item] of allItems.entries()) {
      if (item._tag !== "Block") continue
      const block = model.blocks[item.index] as TranscriptBlock | undefined
      if (block?._tag === "ToolCall" || block?._tag === "SubagentCard") itemPositionByBlockId.set(block.id, position)
    }
    const rootPositionOf = (start: number): number => {
      let position = start
      const seen = new Set<number>()
      while (!seen.has(position)) {
        seen.add(position)
        const parentId = allItems[position]?.parentId
        if (parentId === undefined) return position
        const parentPosition = itemPositionByBlockId.get(parentId)
        if (parentPosition === undefined) return position
        position = parentPosition
      }
      return position
    }
    const unitMembers = new Map<number, Array<number>>()
    const unitRoots: Array<number> = []
    for (let position = 0; position < windowEnd; position += 1) {
      const root = rootPositionOf(position)
      let members = unitMembers.get(root)
      if (members === undefined) {
        members = []
        unitMembers.set(root, members)
        unitRoots.push(root)
      }
      members.push(position)
    }
    const expandedRows = new Set(model.expandedRowKeys)
    const visibleByPosition = new Map<number, boolean>()
    const isVisiblePosition = (position: number): boolean => {
      const cached = visibleByPosition.get(position)
      if (cached !== undefined) return cached
      let visible = true
      const seen = new Set<number>()
      let current = position
      while (!seen.has(current)) {
        seen.add(current)
        const parentId = allItems[current]?.parentId
        if (parentId === undefined) break
        if (!expandedRows.has(`tool:${parentId}`) && !expandedRows.has(`subagent:${parentId}`)) {
          visible = false
          break
        }
        const parent = itemPositionByBlockId.get(parentId)
        if (parent === undefined) break
        current = parent
      }
      visibleByPosition.set(position, visible)
      return visible
    }
    const orderedRoots = unitRoots.toSorted((left, right) => left - right)
    const selectedPositions = new Set<number>()
    let visibleSelected = 0
    for (let unitIndex = orderedRoots.length - 1; unitIndex >= 0; unitIndex -= 1) {
      const members = unitMembers.get(orderedRoots[unitIndex]!)!
      const remainingVisible = limit - visibleSelected
      const remainingMounted = maxBoundedTranscriptItems - selectedPositions.size
      if (remainingVisible <= 0 || remainingMounted <= 0) break
      const visibleMembers = members.reduce((count, position) => count + (isVisiblePosition(position) ? 1 : 0), 0)
      if (visibleMembers <= remainingVisible && members.length <= remainingMounted) {
        for (const position of members) selectedPositions.add(position)
        visibleSelected += visibleMembers
        continue
      }
      const required = new Set<number>()
      let requiredVisible = 0
      const ancestorsOf = (position: number): ReadonlyArray<number> => {
        const ancestors: Array<number> = []
        const seen = new Set<number>()
        let current = position
        while (!seen.has(current)) {
          seen.add(current)
          const parentId = allItems[current]?.parentId
          if (parentId === undefined) break
          const parent = itemPositionByBlockId.get(parentId)
          if (parent === undefined) break
          ancestors.unshift(parent)
          current = parent
        }
        return ancestors
      }
      for (let position = members.length - 1; position >= 0; position -= 1) {
        const member = members[position]!
        const additions = [...ancestorsOf(member), member].filter((candidate) => !required.has(candidate))
        if (required.size + additions.length > remainingMounted) break
        const additionsVisible = additions.reduce(
          (count, candidate) => count + (isVisiblePosition(candidate) ? 1 : 0),
          0,
        )
        if (requiredVisible + additionsVisible > remainingVisible) break
        for (const addition of additions) required.add(addition)
        requiredVisible += additionsVisible
      }
      for (const position of required) selectedPositions.add(position)
      visibleSelected += requiredVisible
    }
    const source = [...selectedPositions].toSorted((left, right) => left - right).map((position) => allItems[position]!)
    const entries: Array<Model["entries"][number]> = []
    const blocks: Array<Model["blocks"][number]> = []
    const entryIndices = new Map<number, number>()
    const blockIndices = new Map<number, number>()
    const items: Array<TranscriptItem> = []
    for (const item of source) {
      if (item._tag === "Entry") {
        let index = entryIndices.get(item.index)
        if (index === undefined) {
          index = entries.length
          entryIndices.set(item.index, index)
          entries.push(model.entries[item.index]!)
        }
        items.push({ ...item, index })
        continue
      }
      let index = blockIndices.get(item.index)
      if (index === undefined) {
        index = blocks.length
        blockIndices.set(item.index, index)
        blocks.push(model.blocks[item.index]!)
      }
      items.push({ ...item, index })
    }
    return { ...model, entries, blocks, items }
  },
)

export interface TranscriptUnitBuild {
  readonly chunks: ReadonlyArray<TextChunk>
  readonly lines: number
  readonly root: UnitLineRange
  readonly nested: ReadonlyArray<UnitLineRange>
}

const offsetUnitRangeImpl = (range: UnitLineRange, offset: number): UnitLineRange => ({
  ...range,
  start: range.start + offset,
  end: range.end + offset,
  ...(range.headerEnd === undefined ? {} : { headerEnd: range.headerEnd + offset }),
})

export const offsetUnitRange: {
  (
    arg1: Parameters<typeof offsetUnitRangeImpl>[1],
  ): (arg0: Parameters<typeof offsetUnitRangeImpl>[0]) => ReturnType<typeof offsetUnitRangeImpl>
  (
    arg0: Parameters<typeof offsetUnitRangeImpl>[0],
    arg1: Parameters<typeof offsetUnitRangeImpl>[1],
  ): ReturnType<typeof offsetUnitRangeImpl>
} = Function.dual(2, offsetUnitRangeImpl)
