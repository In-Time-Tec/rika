import { compareUnitOrder } from "@rika/transcript/transcript-unit-order"
import { Block } from "@rika/transcript/transcript-presentation-model"
import { UnitOrder, type Unit } from "@rika/transcript/transcript-unit"
import { Function, Schema } from "effect"
export interface UnitDelta {
  readonly upsert: ReadonlyArray<Unit>
  readonly remove: ReadonlyArray<string>
}
import { outcomeShadow, updateExecutionOutcomes } from "./projection-outcomes"
import type { Model } from "../../state/model"
import type { TranscriptItem as TranscriptItemModel } from "../../state/transcript/model"

const EventData = Schema.Record(Schema.String, Schema.Unknown)
type EventData = typeof EventData.Type

export interface Event {
  readonly turnId?: string
  readonly cursor: string
  readonly sequence: number
  readonly type: string
  readonly text?: string
  readonly content?: ReadonlyArray<unknown>
  readonly data?: Readonly<EventData>
}

const TranscriptItem = Schema.Union([
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
const isBlock = Schema.is(Block)
const isTranscriptItem = Schema.is(TranscriptItem)

const isCancellationNotice = (unit: Unit): boolean =>
  unit.key.startsWith("execution:") &&
  unit.key.endsWith(":cancelled") &&
  unit.content._tag === "Entry" &&
  unit.content.role === "notice"

const cancelledUnit = (unit: Unit): Unit => {
  if (unit.content._tag !== "Block") return unit
  const block = unit.content.block
  if (
    (block._tag !== "ToolCall" && block._tag !== "SubagentCard") ||
    (block.status !== "queued" && block.status !== "running")
  )
    return unit
  return {
    ...unit,
    content: { _tag: "Block", block: { ...block, status: "cancelled" } },
  }
}

const normalizeCancellation = (units: ReadonlyArray<Unit>, parentId?: string) => {
  const cancelledTurns = new Set(units.filter(isCancellationNotice).map((unit) => unit.turnId))
  if (cancelledTurns.size === 0) return { units, parentIds: new Set<string>() }
  const markerTurns = new Set(
    units.flatMap((unit) => {
      if (unit.content._tag !== "Block" || unit.content.block._tag !== "ToolCall") return []
      return unit.content.block.presentation.family === "agent" && cancelledTurns.has(unit.turnId) ? [unit.turnId] : []
    }),
  )
  const cancelledParentIds = new Set(
    units.flatMap((unit) => {
      if (unit.content._tag !== "Block" || unit.content.block._tag !== "ToolCall") return []
      return unit.content.block.presentation.family === "agent" && cancelledTurns.has(unit.turnId)
        ? [unit.content.block.id]
        : []
    }),
  )
  let inherited = true
  while (inherited) {
    inherited = false
    for (const unit of units) {
      if (unit.parentId === undefined || !cancelledParentIds.has(unit.parentId) || unit.content._tag !== "Block")
        continue
      const block = unit.content.block
      if (block._tag !== "ToolCall" || block.presentation.family !== "agent" || cancelledParentIds.has(block.id))
        continue
      cancelledParentIds.add(block.id)
      inherited = true
    }
  }
  const parentIds = new Set<string>()
  for (const unit of units) {
    const resolvedParentId = unit.parentId ?? parentId
    if (cancelledTurns.has(unit.turnId) && resolvedParentId !== undefined) parentIds.add(resolvedParentId)
  }
  return {
    units: units
      .filter(
        (unit) =>
          !isCancellationNotice(unit) || ((unit.parentId ?? parentId) === undefined && !markerTurns.has(unit.turnId)),
      )
      .map((unit) =>
        cancelledTurns.has(unit.turnId) || (unit.parentId !== undefined && cancelledParentIds.has(unit.parentId))
          ? cancelledUnit(unit)
          : unit,
      ),
    parentIds,
  }
}

const cancelParentRows = (model: Model, parentIds: ReadonlySet<string>): Model => {
  if (parentIds.size === 0) return model
  let changed = false
  const blocks = model.blocks.map((candidate) => {
    if (
      !isBlock(candidate) ||
      candidate._tag !== "ToolCall" ||
      candidate.status !== "running" ||
      !parentIds.has(candidate.id)
    )
      return candidate
    changed = true
    const cancelled: Block = { ...candidate, status: "cancelled" }
    return cancelled
  })
  return changed ? { ...model, blocks } : model
}

const knownIndexCache = new WeakMap<ReadonlyArray<unknown>, Map<string, number>>()

type TranscriptItem = TranscriptItemModel

const knownIndexesFor = (items: ReadonlyArray<TranscriptItem>): Map<string, number> => {
  const cached = knownIndexCache.get(items)
  if (cached !== undefined) return cached
  const built = new Map<string, number>()
  for (const [index, item] of items.entries()) if (item.id !== undefined) built.set(item.id, index)
  knownIndexCache.set(items, built)
  return built
}

const insertionPosition = (
  items: ReadonlyArray<TranscriptItem>,
  unit: Unit,
  rootTurnId: string | undefined,
): number => {
  const rootId = rootTurnId ?? unit.turnId
  const last = items.at(-1)
  if (
    last !== undefined &&
    (last.rootTurnId ?? last.turnId) === rootId &&
    (last.order === undefined || compareUnitOrder(last.order, unit.order) <= 0)
  )
    return items.length
  let lastMatchingTurn = -1
  for (const [index, item] of items.entries()) {
    if ((item.rootTurnId ?? item.turnId) !== rootId) continue
    lastMatchingTurn = index
    if (item.order !== undefined && compareUnitOrder(item.order, unit.order) > 0) return index
  }
  return lastMatchingTurn < 0 ? items.length : lastMatchingTurn + 1
}

const parentIsCancelled = (blocks: ReadonlyArray<Block>, parentId: string | undefined): boolean =>
  parentId !== undefined &&
  blocks.some((block) => block._tag === "ToolCall" && block.id === parentId && block.status === "cancelled")

const entryIsUnchanged = (
  cancellationActive: boolean,
  stored: Model["entries"][number] | undefined,
  unit: Unit,
): boolean =>
  unit.content._tag === "Entry" &&
  !cancellationActive &&
  stored !== undefined &&
  stored.role === unit.content.role &&
  stored.text === unit.content.text &&
  stored.turnId === unit.turnId

const blockIsUnchanged = (cancellationActive: boolean, stored: Block | undefined, block: Block): boolean => {
  const shadow = outcomeShadow.get(block)
  return !cancellationActive && (stored === block || (shadow !== undefined && shadow.applied === stored))
}

const itemContextChanged = (
  current: TranscriptItem,
  nestedParentId: string | undefined,
  rootTurnId: string | undefined,
): boolean =>
  (nestedParentId !== undefined && current.parentId !== nestedParentId) ||
  (rootTurnId !== undefined && current.rootTurnId !== rootTurnId) ||
  current.order === undefined

const projectUnitsImpl = (model: Model, units: ReadonlyArray<Unit>, parentId?: string, rootTurnId?: string): Model => {
  const modelBlocks = model.blocks.filter(isBlock)
  const parentCancelled = parentIsCancelled(modelBlocks, parentId)
  const cancellation = normalizeCancellation(parentCancelled ? units.map(cancelledUnit) : units, parentId)
  const cancellationActive = parentCancelled || cancellation.units !== units || cancellation.parentIds.size > 0
  const projectedModel = cancelParentRows(model, cancellation.parentIds)
  let entries = [...projectedModel.entries]
  let blocks = projectedModel.blocks.filter(isBlock)
  let items = projectedModel.items.filter(isTranscriptItem)
  let entriesCloned = false
  let blocksCloned = false
  let itemsCloned = false
  const writtenToolIds = new Set<string>()
  let known = knownIndexesFor(items)
  let knownCloned = false
  const rememberIndex = (key: string, index: number) => {
    if (!knownCloned) {
      known = new Map(known)
      knownCloned = true
    }
    known.set(key, index)
  }
  const writeEntry = (index: number, value: Model["entries"][number]) => {
    if (!entriesCloned) {
      entries = [...entries]
      entriesCloned = true
    }
    entries[index] = value
  }
  const writeBlock = (index: number, value: Block) => {
    if (!blocksCloned) {
      blocks = [...blocks]
      blocksCloned = true
    }
    blocks[index] = value
    if (value._tag === "ToolCall") writtenToolIds.add(value.id)
  }
  const writeItem = (index: number, value: TranscriptItem) => {
    if (!itemsCloned) {
      items = [...items]
      itemsCloned = true
    }
    items[index] = value
  }
  const insertItem = (index: number, value: TranscriptItem) => {
    if (index === items.length) {
      writeItem(index, value)
      if (value.id !== undefined) rememberIndex(value.id, index)
      return
    }
    if (!itemsCloned) {
      items = [...items]
      itemsCloned = true
    }
    items.splice(index, 0, value)
    known = new Map()
    for (const [position, item] of items.entries()) if (item.id !== undefined) known.set(item.id, position)
    knownCloned = true
  }
  const updateCurrentUnit = (
    itemIndex: number,
    current: TranscriptItem,
    unit: Unit,
    nestedParentId: string | undefined,
  ) => {
    if (unit.content._tag === "Entry" && current._tag === "Entry") {
      const stored = entries[current.index]
      if (!entryIsUnchanged(cancellationActive, stored, unit))
        writeEntry(current.index, { ...unit.content, turnId: unit.turnId })
    } else if (unit.content._tag === "Block" && current._tag === "Block") {
      const stored = blocks[current.index]
      if (!blockIsUnchanged(cancellationActive, stored, unit.content.block))
        writeBlock(current.index, unit.content.block)
    }
    if (!itemContextChanged(current, nestedParentId, rootTurnId)) return
    const updated: TranscriptItem = { ...current, order: current.order ?? unit.order }
    const withParent: TranscriptItem = nestedParentId === undefined ? updated : { ...updated, parentId: nestedParentId }
    writeItem(itemIndex, rootTurnId === undefined ? withParent : { ...withParent, rootTurnId })
  }
  const insertUnit = (unit: Unit, nestedParentId: string | undefined) => {
    const itemPosition = insertionPosition(items, unit, rootTurnId)
    const index = unit.content._tag === "Entry" ? entries.length : blocks.length
    if (unit.content._tag === "Entry") writeEntry(index, { ...unit.content, turnId: unit.turnId })
    else writeBlock(index, unit.content.block)
    const item: TranscriptItem = {
      _tag: unit.content._tag,
      index,
      id: unit.key,
      turnId: unit.turnId,
      order: unit.order,
    }
    const rooted = rootTurnId === undefined ? item : { ...item, rootTurnId }
    insertItem(itemPosition, nestedParentId === undefined ? rooted : { ...rooted, parentId: nestedParentId })
  }
  const applyUnit = (rawUnit: Unit) => {
    const nestedParentId = parentId ?? rawUnit.parentId
    const unit =
      nestedParentId === undefined || rawUnit.parentId === nestedParentId
        ? rawUnit
        : { ...rawUnit, parentId: nestedParentId }
    const itemIndex = known.get(unit.key)
    const current = itemIndex === undefined ? undefined : items[itemIndex]
    if (current !== undefined) {
      if (itemIndex === undefined) return
      updateCurrentUnit(itemIndex, current, unit, nestedParentId)
      return
    }
    insertUnit(unit, nestedParentId)
  }
  for (const unit of cancellation.units) applyUnit(unit)
  if (itemsCloned) knownIndexCache.set(items, known)
  const base =
    entriesCloned || blocksCloned || itemsCloned ? { ...projectedModel, entries, blocks, items } : projectedModel
  return updateExecutionOutcomes(base, units, [], writtenToolIds, parentId)
}

interface RemovedUnits {
  readonly positions: ReadonlySet<number>
  readonly entryIndexes: ReadonlySet<number>
  readonly blockIndexes: ReadonlySet<number>
  readonly rowKeys: ReadonlySet<string>
}

const removedUnits = (model: Model, keys: ReadonlyArray<string>): RemovedUnits => {
  const known = knownIndexesFor(model.items.filter(isTranscriptItem))
  const removedPositions = new Set<number>()
  const removedEntryIndexes = new Set<number>()
  const removedBlockIndexes = new Set<number>()
  const removedRowKeys = new Set<string>()
  for (const key of keys) {
    const position = known.get(key)
    if (position === undefined) continue
    const item = model.items[position]
    if (!isTranscriptItem(item)) continue
    removedPositions.add(position)
    if (item._tag === "Entry") {
      removedEntryIndexes.add(item.index)
      removedRowKeys.add(`entry:${key}`)
    } else {
      removedBlockIndexes.add(item.index)
      removedRowKeys.add(`block:${key}`)
      const block = model.blocks[item.index]
      if (!isBlock(block)) continue
      if (block?._tag === "ToolCall") removedRowKeys.add(`tool:${block.id}`)
    }
  }
  return {
    positions: removedPositions,
    entryIndexes: removedEntryIndexes,
    blockIndexes: removedBlockIndexes,
    rowKeys: removedRowKeys,
  }
}

const removeUnits = (model: Model, keys: ReadonlyArray<string>): Model => {
  if (keys.length === 0) return model
  const updatedModel = updateExecutionOutcomes(model, [], keys, new Set())
  const removed = removedUnits(updatedModel, keys)
  const removedPositions = removed.positions
  const removedEntryIndexes = removed.entryIndexes
  const removedBlockIndexes = removed.blockIndexes
  const removedRowKeys = removed.rowKeys
  if (removedPositions.size === 0) return updatedModel
  const entryIndexes = new Map<number, number>()
  const entries = updatedModel.entries.filter((_, index) => {
    if (removedEntryIndexes.has(index)) return false
    entryIndexes.set(index, entryIndexes.size)
    return true
  })
  const blockIndexes = new Map<number, number>()
  const blocks = updatedModel.blocks.filter((_, index) => {
    if (removedBlockIndexes.has(index)) return false
    blockIndexes.set(index, blockIndexes.size)
    return true
  })
  const items: Array<TranscriptItem> = []
  for (const [position, candidate] of updatedModel.items.entries()) {
    if (!isTranscriptItem(candidate)) continue
    const item = candidate
    if (removedPositions.has(position)) continue
    const index = item._tag === "Entry" ? entryIndexes.get(item.index) : blockIndexes.get(item.index)
    if (index === undefined) continue
    items.push(index === item.index ? item : { ...item, index })
  }
  const expandedRowKeys = updatedModel.expandedRowKeys.filter((key) => !removedRowKeys.has(key))
  const explicitlyCollapsedRowKeys = updatedModel.explicitlyCollapsedRowKeys.filter((key) => !removedRowKeys.has(key))
  const detailSelection =
    updatedModel.detailSelection === undefined || !removedRowKeys.has(updatedModel.detailSelection)
      ? updatedModel.detailSelection
      : undefined
  return {
    ...updatedModel,
    entries: removedEntryIndexes.size === 0 ? updatedModel.entries : entries,
    blocks: removedBlockIndexes.size === 0 ? updatedModel.blocks : blocks,
    items,
    expandedRowKeys,
    explicitlyCollapsedRowKeys,
    detailSelection,
  }
}

export const projectUnitDelta: {
  (model: Model, rootTurnId: string, delta: UnitDelta): Model
  (rootTurnId: string, delta: UnitDelta): (model: Model) => Model
} = Function.dual(3, (model: Model, rootTurnId: string, delta: UnitDelta): Model => {
  const upserted = new Set(delta.upsert.map((unit) => unit.key))
  const removed = removeUnits(
    model,
    delta.remove.filter((key) => !upserted.has(key)),
  )
  return projectUnitsImpl(removed, delta.upsert, undefined, rootTurnId)
})

export const projectRootUnits: {
  (model: Model, rootTurnId: string, units: ReadonlyArray<Unit>): Model
  (rootTurnId: string, units: ReadonlyArray<Unit>): (model: Model) => Model
} = Function.dual(
  3,
  (model: Model, rootTurnId: string, units: ReadonlyArray<Unit>): Model =>
    projectUnitsImpl(model, units, undefined, rootTurnId),
)

export const projectUnits: {
  (model: import("../../state/model").Model, units: ReadonlyArray<Unit>): import("../../state/model").Model
  (units: ReadonlyArray<Unit>): (model: import("../../state/model").Model) => import("../../state/model").Model
} = Function.dual(
  2,
  (model: import("../../state/model").Model, units: ReadonlyArray<Unit>): import("../../state/model").Model =>
    projectUnitsImpl(model, units),
)

export const projectChildUnits: {
  (
    model: import("../../state/model").Model,
    parentId: string,
    units: ReadonlyArray<Unit>,
  ): import("../../state/model").Model
  (
    parentId: string,
    units: ReadonlyArray<Unit>,
  ): (model: import("../../state/model").Model) => import("../../state/model").Model
} = Function.dual(3, (model: import("../../state/model").Model, parentId: string, units: ReadonlyArray<Unit>) => {
  const projected = projectUnitsImpl(model, units, parentId)
  const parentCancelled = projected.blocks
    .filter(isBlock)
    .some((block) => block._tag === "ToolCall" && block.id === parentId && block.status === "cancelled")
  if (!parentCancelled) return projected
  const childIndexes = new Set(
    projected.items
      .filter(isTranscriptItem)
      .flatMap((item) => (item._tag === "Block" && item.parentId === parentId ? [item.index] : [])),
  )
  const blocks = projected.blocks.filter(isBlock)
  for (const index of childIndexes) {
    const block = blocks[index]
    if (block === undefined) continue
    if (
      (block._tag !== "ToolCall" && block._tag !== "SubagentCard") ||
      (block.status !== "queued" && block.status !== "running")
    )
      continue
    const cancelled: Block = { ...block, status: "cancelled" }
    blocks[index] = cancelled
  }
  return {
    ...projected,
    blocks,
  }
})
