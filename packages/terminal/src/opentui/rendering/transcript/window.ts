import { Function, Schema } from "effect"
import { Block } from "@rika/transcript/transcript-presentation-model"
import { Model } from "../../../state/model"
import type { TranscriptItem } from "../../../state/transcript/model"
import { orderedTranscriptItems } from "../../../presentation/transcript/row"
import type { TextChunk } from "@opentui/core"
import type { PathTarget } from "../../../presentation/transcript/tool/detail-types"
import { spacing } from "../../../presentation/terminal/theme"

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

interface ParentProjection {
  readonly itemPositionByBlockId: ReadonlyMap<string, number>
  readonly cellBlockIds: ReadonlySet<string>
}
interface PartialUnitFit {
  readonly positions: ReadonlySet<number>
  readonly visible: number
}

const hasParentBefore = (items: ReadonlyArray<TranscriptItem>, end: number): boolean =>
  items.slice(0, end).some((item) => item.parentId !== undefined)

const projectItems = (model: Model, source: ReadonlyArray<TranscriptItem>): BoundedTranscriptModel => {
  const entries: Array<Model["entries"][number]> = []
  const blocks: Array<Model["blocks"][number]> = []
  const entryIndices = new Map<number, number>()
  const blockIndices = new Map<number, number>()
  const items: Array<TranscriptItem> = []
  for (const item of source) {
    const indices = item._tag === "Entry" ? entryIndices : blockIndices
    const values = item._tag === "Entry" ? entries : blocks
    let index = indices.get(item.index)
    if (index === undefined) {
      index = values.length
      indices.set(item.index, index)
      if (item._tag === "Entry") entries.push(model.entries[item.index]!)
      else blocks.push(model.blocks[item.index])
    }
    items.push({ ...item, index })
  }
  return { ...model, entries, blocks, items }
}

const parentProjection = (model: Model, items: ReadonlyArray<TranscriptItem>): ParentProjection => {
  const itemPositionByBlockId = new Map<string, number>()
  const cellBlockIds = new Set<string>()
  for (const [position, item] of items.entries()) {
    if (item._tag !== "Block") continue
    const candidate = model.blocks[item.index]
    const block = candidate === undefined ? undefined : Schema.decodeUnknownSync(Block)(candidate)
    if (block?._tag === "ToolCall" || block?._tag === "SubagentCard") itemPositionByBlockId.set(block.id, position)
    if (block?._tag === "Cell") cellBlockIds.add(block.id)
  }
  return { itemPositionByBlockId, cellBlockIds }
}

const ancestorPositions = (
  position: number,
  items: ReadonlyArray<TranscriptItem>,
  parentPositions: ReadonlyMap<string, number>,
): ReadonlyArray<number> => {
  const ancestors: Array<number> = []
  const seen = new Set<number>()
  let current = position
  while (!seen.has(current)) {
    seen.add(current)
    const parentId = items[current]?.parentId
    if (parentId === undefined) break
    const parent = parentPositions.get(parentId)
    if (parent === undefined) break
    ancestors.unshift(parent)
    current = parent
  }
  return ancestors
}

const rootPosition = (
  start: number,
  items: ReadonlyArray<TranscriptItem>,
  parentPositions: ReadonlyMap<string, number>,
): number => {
  let position = start
  const seen = new Set<number>()
  while (!seen.has(position)) {
    seen.add(position)
    const parentId = items[position]?.parentId
    if (parentId === undefined) return position
    const parentPosition = parentPositions.get(parentId)
    if (parentPosition === undefined) return position
    position = parentPosition
  }
  return position
}

const groupUnitPositions = (
  items: ReadonlyArray<TranscriptItem>,
  end: number,
  parentPositions: ReadonlyMap<string, number>,
): ReadonlyMap<number, ReadonlyArray<number>> => {
  const units = new Map<number, Array<number>>()
  for (let position = 0; position < end; position += 1) {
    const root = rootPosition(position, items, parentPositions)
    const members = units.get(root)
    if (members === undefined) units.set(root, [position])
    else members.push(position)
  }
  return units
}

const positionVisibility = (
  items: ReadonlyArray<TranscriptItem>,
  projection: ParentProjection,
  expandedRowKeys: ReadonlyArray<string>,
): ((position: number) => boolean) => {
  const expandedRows = new Set(expandedRowKeys)
  const visibleByPosition = new Map<number, boolean>()
  return (position) => {
    const cached = visibleByPosition.get(position)
    if (cached !== undefined) return cached
    const originalPosition = position
    let visible = true
    const seen = new Set<number>()
    let current = position
    while (!seen.has(current)) {
      seen.add(current)
      const parentId = items[current]?.parentId
      if (parentId === undefined) break
      if (projection.cellBlockIds.has(parentId)) break
      if (!expandedRows.has(`tool:${parentId}`) && !expandedRows.has(`subagent:${parentId}`)) {
        visible = false
        break
      }
      const parent = projection.itemPositionByBlockId.get(parentId)
      if (parent === undefined) break
      current = parent
    }
    visibleByPosition.set(originalPosition, visible)
    return visible
  }
}

const fitPartialUnit = (
  members: ReadonlyArray<number>,
  items: ReadonlyArray<TranscriptItem>,
  parentPositions: ReadonlyMap<string, number>,
  isVisible: (position: number) => boolean,
  remainingVisible: number,
  remainingMounted: number,
): PartialUnitFit => {
  const positions = new Set<number>()
  let visible = 0
  for (let index = members.length - 1; index >= 0; index -= 1) {
    const member = members[index]!
    const additions = [...ancestorPositions(member, items, parentPositions), member].filter(
      (candidate) => !positions.has(candidate),
    )
    if (positions.size + additions.length > remainingMounted) break
    const additionsVisible = additions.reduce((count, candidate) => count + (isVisible(candidate) ? 1 : 0), 0)
    if (visible + additionsVisible > remainingVisible) break
    for (const addition of additions) positions.add(addition)
    visible += additionsVisible
  }
  return { positions, visible }
}

const selectUnitPositions = (
  units: ReadonlyMap<number, ReadonlyArray<number>>,
  items: ReadonlyArray<TranscriptItem>,
  projection: ParentProjection,
  isVisible: (position: number) => boolean,
): ReadonlySet<number> => {
  const selected = new Set<number>()
  let visibleSelected = 0
  const orderedUnits = [...units.entries()].toSorted(([left], [right]) => left - right)
  for (let unitIndex = orderedUnits.length - 1; unitIndex >= 0; unitIndex -= 1) {
    const members = orderedUnits[unitIndex]![1]
    const remainingVisible = maxMountedTranscriptEntries - visibleSelected
    const remainingMounted = maxBoundedTranscriptItems - selected.size
    if (remainingVisible <= 0 || remainingMounted <= 0) break
    const visibleMembers = members.reduce((count, position) => count + (isVisible(position) ? 1 : 0), 0)
    if (visibleMembers <= remainingVisible && members.length <= remainingMounted) {
      for (const position of members) selected.add(position)
      visibleSelected += visibleMembers
      continue
    }
    const partial = fitPartialUnit(
      members,
      items,
      projection.itemPositionByBlockId,
      isVisible,
      remainingVisible,
      remainingMounted,
    )
    for (const position of partial.positions) selected.add(position)
    visibleSelected += partial.visible
  }
  return selected
}

export const boundedTranscriptModel: {
  (model: Model): BoundedTranscriptModel
  (model: Model, end: number): BoundedTranscriptModel
  (end: number): (model: Model) => BoundedTranscriptModel
} = Function.dual(
  (args) => Schema.is(Model)(args[0]),
  (model: Model, end: number = model.items.length): BoundedTranscriptModel => {
    const boundedEnd = end
    const limit = maxMountedTranscriptEntries
    if (model.items.length === 0)
      return {
        ...model,
        entries: model.entries.slice(-limit),
        blocks: model.blocks.slice(-limit),
        items: [],
      }
    const windowEnd = Math.min(model.items.length, Math.max(0, Math.floor(boundedEnd)))
    if (windowEnd === model.items.length && model.items.length <= limit)
      return { ...model, items: orderedTranscriptItems(model) }
    const allItems = orderedTranscriptItems(model)
    if (!hasParentBefore(allItems, windowEnd)) {
      const flat = allItems.slice(Math.max(0, windowEnd - limit), windowEnd)
      return projectItems(model, flat)
    }
    const projection = parentProjection(model, allItems)
    const unitMembers = groupUnitPositions(allItems, windowEnd, projection.itemPositionByBlockId)
    const isVisiblePosition = positionVisibility(allItems, projection, model.expandedRowKeys)
    const selectedPositions = selectUnitPositions(unitMembers, allItems, projection, isVisiblePosition)
    const source = [...selectedPositions].toSorted((left, right) => left - right).map((position) => allItems[position]!)
    return projectItems(model, source)
  },
)

export interface TranscriptUnitBuild {
  readonly chunks: ReadonlyArray<TextChunk>
  readonly lines: number
  readonly root: UnitLineRange
  readonly nested: ReadonlyArray<UnitLineRange>
}

const offsetUnitRangeImpl = (range: UnitLineRange, offset: number): UnitLineRange =>
  range.headerEnd === undefined
    ? { ...range, start: range.start + offset, end: range.end + offset }
    : { ...range, start: range.start + offset, end: range.end + offset, headerEnd: range.headerEnd + offset }

export const offsetUnitRange: {
  (
    arg1: Parameters<typeof offsetUnitRangeImpl>[1],
  ): (arg0: Parameters<typeof offsetUnitRangeImpl>[0]) => ReturnType<typeof offsetUnitRangeImpl>
  (
    arg0: Parameters<typeof offsetUnitRangeImpl>[0],
    arg1: Parameters<typeof offsetUnitRangeImpl>[1],
  ): ReturnType<typeof offsetUnitRangeImpl>
} = Function.dual(2, offsetUnitRangeImpl)
