import { compareUnitOrder } from "@rika/transcript/transcript-unit-order"
import { Block } from "@rika/transcript/transcript-presentation-model"
import type { Unit } from "@rika/transcript/transcript-unit"
import { Function } from "effect"
export interface UnitDelta {
  readonly upsert: ReadonlyArray<Unit>
  readonly remove: ReadonlyArray<string>
}
import { outcomeShadow, updateExecutionOutcomes } from "./projection-outcomes"
import type { Model } from "../../state/model"
import type { TranscriptItem as TranscriptItemModel } from "../../state/transcript/model"
import { knownIndexesFor, ProjectionIndexCache, recordArrayCopy } from "./projection-cache"

export { resetTranscriptProjectionDiagnostics, transcriptProjectionDiagnostics } from "./projection-cache"

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
    if (candidate._tag !== "ToolCall" || candidate.status !== "running" || !parentIds.has(candidate.id))
      return candidate
    changed = true
    const cancelled: Block = { ...candidate, status: "cancelled" }
    return cancelled
  })
  return changed ? { ...model, blocks } : model
}

type TranscriptItem = TranscriptItemModel

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
  const modelBlocks = model.blocks
  const parentCancelled = parentIsCancelled(modelBlocks, parentId)
  const cancellation = normalizeCancellation(parentCancelled ? units.map(cancelledUnit) : units, parentId)
  const cancellationActive = parentCancelled || cancellation.units !== units || cancellation.parentIds.size > 0
  const projectedModel = cancelParentRows(model, cancellation.parentIds)
  let entries: ReadonlyArray<Model["entries"][number]> = projectedModel.entries
  let blocks: ReadonlyArray<Block> = projectedModel.blocks
  let items: ReadonlyArray<TranscriptItem> = projectedModel.items
  let mutableEntries: Array<Model["entries"][number]> | undefined
  let mutableBlocks: Array<Block> | undefined
  let mutableItems: Array<TranscriptItem> | undefined
  let tentativeMutated = false
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
    if (mutableEntries === undefined) {
      recordArrayCopy(entries.length)
      mutableEntries = Array.from(entries)
      entries = mutableEntries
    }
    mutableEntries[index] = value
  }
  const writeBlock = (index: number, value: Block) => {
    if (mutableBlocks === undefined) {
      recordArrayCopy(blocks.length)
      mutableBlocks = Array.from(blocks)
      blocks = mutableBlocks
    }
    mutableBlocks[index] = value
    if (value._tag === "ToolCall") writtenToolIds.add(value.id)
  }
  const writeItem = (index: number, value: TranscriptItem) => {
    if (mutableItems === undefined) {
      recordArrayCopy(items.length)
      mutableItems = Array.from(items)
      items = mutableItems
    }
    mutableItems[index] = value
  }
  const insertItem = (index: number, value: TranscriptItem) => {
    if (index === items.length) {
      writeItem(index, value)
      if (value.id !== undefined) rememberIndex(value.id, index)
      return
    }
    if (mutableItems === undefined) {
      recordArrayCopy(items.length)
      mutableItems = Array.from(items)
      items = mutableItems
    }
    mutableItems.splice(index, 0, value)
    known = new Map()
    for (const [position, item] of items.entries()) if (item.id !== undefined) known.set(item.id, position)
    knownCloned = true
  }
  const updateCurrentEntry = (current: TranscriptItem, unit: Unit) => {
    if (unit.content._tag !== "Entry" || current._tag !== "Entry") return
    const stored = entries[current.index]
    if (entryIsUnchanged(cancellationActive, stored, unit)) return
    const entry = { ...unit.content, turnId: unit.turnId }
    if (!cancellationActive && unit.key.startsWith("tentative:")) {
      Reflect.set(entries, current.index, entry)
      tentativeMutated = true
    } else writeEntry(current.index, entry)
  }
  const updateCurrentBlock = (current: TranscriptItem, unit: Unit) => {
    if (unit.content._tag !== "Block" || current._tag !== "Block") return
    const block = unit.content.block
    if (blockIsUnchanged(cancellationActive, blocks[current.index], block)) return
    if (!cancellationActive && unit.key.startsWith("tentative:")) {
      Reflect.set(blocks, current.index, block)
      tentativeMutated = true
      if (block._tag === "ToolCall") writtenToolIds.add(block.id)
    } else writeBlock(current.index, block)
  }
  const updateCurrentUnit = (
    itemIndex: number,
    current: TranscriptItem,
    unit: Unit,
    nestedParentId: string | undefined,
  ) => {
    updateCurrentEntry(current, unit)
    updateCurrentBlock(current, unit)
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
  if (mutableItems !== undefined) ProjectionIndexCache.set(items, known)
  const base =
    mutableEntries !== undefined || mutableBlocks !== undefined || mutableItems !== undefined || tentativeMutated
      ? {
          ...projectedModel,
          entries,
          blocks,
          items,
          transcriptRevision: projectedModel.transcriptRevision + (tentativeMutated ? 1 : 0),
        }
      : projectedModel
  return updateExecutionOutcomes(base, units, [], writtenToolIds, parentId)
}

interface RemovedUnits {
  readonly positions: ReadonlySet<number>
  readonly entryIndexes: ReadonlySet<number>
  readonly blockIndexes: ReadonlySet<number>
  readonly rowKeys: ReadonlySet<string>
}

const removedUnits = (model: Model, keys: ReadonlyArray<string>): RemovedUnits => {
  const known = knownIndexesFor(model.items)
  const removedPositions = new Set<number>()
  const removedEntryIndexes = new Set<number>()
  const removedBlockIndexes = new Set<number>()
  const removedRowKeys = new Set<string>()
  for (const key of keys) {
    const position = known.get(key)
    if (position === undefined) continue
    const item = model.items[position]
    if (item === undefined) continue
    removedPositions.add(position)
    if (item._tag === "Entry") {
      removedEntryIndexes.add(item.index)
      removedRowKeys.add(`entry:${key}`)
    } else {
      removedBlockIndexes.add(item.index)
      removedRowKeys.add(`block:${key}`)
      const block = model.blocks[item.index]
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
  const parentCancelled = projected.blocks.some(
    (block) => block._tag === "ToolCall" && block.id === parentId && block.status === "cancelled",
  )
  if (!parentCancelled) return projected
  const childIndexes = new Set(
    projected.items.flatMap((item) => (item._tag === "Block" && item.parentId === parentId ? [item.index] : [])),
  )
  const blocks = [...projected.blocks]
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
