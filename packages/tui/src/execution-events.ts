import type { Block, Unit } from "@rika/transcript"
import { Function } from "effect"
import type { Model, TranscriptItem } from "./view-state"

export interface Event {
  readonly turnId?: string
  readonly cursor: string
  readonly sequence: number
  readonly type: string
  readonly text?: string
  readonly content?: ReadonlyArray<unknown>
  readonly data?: Readonly<Record<string, unknown>>
}

type ToolCall = Extract<Block, { readonly _tag: "ToolCall" }>

const executionKey = (value: string): string => value.replace(/^execution:/, "")

const isCancellationNotice = (unit: Unit): boolean =>
  unit.key.startsWith("execution:") &&
  unit.key.endsWith(":cancelled") &&
  unit.content._tag === "Entry" &&
  unit.content.role === "notice" &&
  unit.content.text === "cancelled"

const cancelledUnit = (unit: Unit): Unit => {
  if (unit.content._tag !== "Block") return unit
  const block = unit.content.block
  if ((block._tag !== "ToolCall" && block._tag !== "ChildAgent") || block.status !== "running") return unit
  return {
    ...unit,
    content: { _tag: "Block", block: { ...block, status: "cancelled" } },
  }
}

const normalizeCancellation = (
  units: ReadonlyArray<Unit>,
  parentId?: string,
): { readonly units: ReadonlyArray<Unit>; readonly parentIds: ReadonlySet<string> } => {
  const cancelledTurns = new Set(units.filter(isCancellationNotice).map((unit) => unit.turnId))
  if (cancelledTurns.size === 0) return { units, parentIds: new Set() }
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
  for (const unit of units)
    if (cancelledTurns.has(unit.turnId) && (unit.parentId ?? parentId) !== undefined)
      parentIds.add((unit.parentId ?? parentId)!)
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
    const block = candidate as Block
    if (block._tag !== "ToolCall" || block.status !== "running" || !parentIds.has(block.id)) return candidate
    changed = true
    return { ...block, status: "cancelled" as const }
  })
  return changed ? { ...model, blocks } : model
}

const childLabels = (name: string, presentation: ToolCall["presentation"]): ToolCall["presentation"] => {
  const normalized = name.replace(/^rika-/, "").trim()
  const lower = normalized.toLowerCase()
  if (lower === "oracle")
    return {
      ...presentation,
      family: "agent",
      action: "oracle",
      activeLabel: "Oracle exploring",
      completeLabel: "Oracle has spoken",
    }
  if (lower === "librarian")
    return {
      ...presentation,
      family: "agent",
      action: "librarian",
      activeLabel: "Librarian researching",
      completeLabel: "Librarian researched",
    }
  if (lower.length === 0 || lower === "child" || lower === "task" || lower === "subagent")
    return {
      ...presentation,
      family: "agent",
      action: "task",
      activeLabel: "Subagent working",
      completeLabel: "Subagent finished",
    }
  const display = normalized.charAt(0).toUpperCase() + normalized.slice(1)
  return {
    ...presentation,
    family: "agent",
    action: lower,
    activeLabel: `${display} working`,
    completeLabel: `${display} finished`,
  }
}

const mergeChildAgent = (tool: Unit, child: Unit): Unit => {
  if (
    tool.content._tag !== "Block" ||
    tool.content.block._tag !== "ToolCall" ||
    child.content._tag !== "Block" ||
    child.content.block._tag !== "ChildAgent"
  )
    return tool
  const status = child.revision < tool.revision ? tool.content.block.status : child.content.block.status
  return {
    ...tool,
    revision: Math.max(tool.revision, child.revision),
    content: {
      _tag: "Block",
      block: {
        ...tool.content.block,
        childId: child.content.block.id,
        status,
        presentation: childLabels(child.content.block.name, tool.content.block.presentation),
      },
    },
  }
}

const reconcileSubagentUnits = (
  model: Model,
  units: ReadonlyArray<Unit>,
): { readonly model: Model; readonly units: ReadonlyArray<Unit> } => {
  const tools = new Map<string, Unit>()
  const toolUnits: Array<Unit> = []
  const children = new Map<string, Unit>()
  const mergedRows = new Map<string, string>()
  for (const unit of units) {
    if (unit.content._tag !== "Block") continue
    const block = unit.content.block
    if (block._tag === "ToolCall") {
      toolUnits.push(unit)
      if (block.childId !== undefined) tools.set(executionKey(block.childId), unit)
    } else if (block._tag === "ChildAgent") children.set(executionKey(block.id), unit)
  }
  const toolForChild = (childId: string): Unit | undefined =>
    tools.get(executionKey(childId)) ??
    toolUnits.find((candidate) => {
      if (candidate.content._tag !== "Block" || candidate.content.block._tag !== "ToolCall") return false
      const block = candidate.content.block
      if (block.presentation.family !== "agent") return false
      const prefix = `${candidate.turnId}:`
      const toolCallId = block.id.startsWith(prefix) ? block.id.slice(prefix.length) : block.id
      return executionKey(childId).endsWith(`:${toolCallId}`)
    })
  const childForTool = (tool: Unit): Unit | undefined =>
    [...children.values()].find((child) => {
      if (child.content._tag !== "Block" || child.content.block._tag !== "ChildAgent") return false
      return toolForChild(child.content.block.id)?.key === tool.key
    })
  for (const item of model.items as ReadonlyArray<TranscriptItem>) {
    if (item._tag !== "Block" || item.id === undefined) continue
    const block = model.blocks[item.index] as Block | undefined
    if (block?._tag !== "ChildAgent") continue
    const tool = toolForChild(block.id)
    if (tool?.content._tag === "Block" && tool.content.block._tag === "ToolCall")
      mergedRows.set(item.id, tool.content.block.id)
  }
  const normalized = units.flatMap((unit) => {
    if (unit.content._tag !== "Block") return [unit]
    const block = unit.content.block
    if (block._tag === "ChildAgent") {
      const tool = toolForChild(block.id)
      if (tool?.content._tag !== "Block" || tool.content.block._tag !== "ToolCall") return [unit]
      mergedRows.set(unit.key, tool.content.block.id)
      return []
    }
    if (block._tag !== "ToolCall") return [unit]
    const child = block.childId === undefined ? childForTool(unit) : children.get(executionKey(block.childId))
    return child === undefined ? [unit] : [mergeChildAgent(unit, child)]
  })
  if (mergedRows.size === 0) return { model, units: normalized }
  const removedBlocks = new Set<number>()
  for (const item of model.items as ReadonlyArray<TranscriptItem>)
    if (item._tag === "Block" && item.id !== undefined && mergedRows.has(item.id)) removedBlocks.add(item.index)
  const blockIndexes = new Map<number, number>()
  const blocks = model.blocks.filter((_, index) => {
    if (removedBlocks.has(index)) return false
    blockIndexes.set(index, blockIndexes.size)
    return true
  })
  const items: Array<TranscriptItem> = []
  for (const item of model.items as ReadonlyArray<TranscriptItem>) {
    if (item._tag === "Entry") {
      items.push(item)
      continue
    }
    if (item.id !== undefined && mergedRows.has(item.id)) continue
    const index = blockIndexes.get(item.index)
    if (index !== undefined) items.push({ ...item, index })
  }
  const canonicalRow = (key: string): string => {
    if (!key.startsWith("block:")) return key
    const toolId = mergedRows.get(key.slice("block:".length))
    return toolId === undefined ? key : `tool:${toolId}`
  }
  return {
    model: {
      ...model,
      blocks,
      items,
      expandedRowKeys: [...new Set(model.expandedRowKeys.map(canonicalRow))],
      detailSelection: model.detailSelection === undefined ? undefined : canonicalRow(model.detailSelection),
    },
    units: normalized,
  }
}

const projectUnitsImpl = (model: Model, units: ReadonlyArray<Unit>, parentId?: string): Model => {
  const parentCancelled =
    parentId !== undefined &&
    (model.blocks as ReadonlyArray<Block>).some(
      (block) => block._tag === "ToolCall" && block.id === parentId && block.status === "cancelled",
    )
  const cancellation = normalizeCancellation(parentCancelled ? units.map(cancelledUnit) : units, parentId)
  const reconciled =
    parentId === undefined ? reconcileSubagentUnits(model, cancellation.units) : { model, units: cancellation.units }
  const projectedModel = cancelParentRows(reconciled.model, cancellation.parentIds)
  const entries = [...projectedModel.entries]
  const blocks = [...projectedModel.blocks] as Array<Block>
  const items = [...projectedModel.items] as Array<TranscriptItem>
  const known = new Map(items.flatMap((item, index) => (item.id === undefined ? [] : [[item.id, index] as const])))
  for (const unit of reconciled.units) {
    const nestedParentId = parentId ?? unit.parentId
    if (
      nestedParentId !== undefined &&
      ((unit.content._tag === "Block" && unit.content.block._tag !== "ToolCall") ||
        (unit.content._tag === "Entry" && unit.content.role !== "assistant"))
    )
      continue
    const itemIndex = known.get(unit.key)
    const current = itemIndex === undefined ? undefined : items[itemIndex]
    if (current !== undefined) {
      if (unit.content._tag === "Entry" && current._tag === "Entry")
        entries[current.index] = { ...unit.content, turnId: unit.turnId }
      else if (unit.content._tag === "Block" && current._tag === "Block") blocks[current.index] = unit.content.block
      if (nestedParentId !== undefined && current.parentId !== nestedParentId)
        items[itemIndex!] = { ...current, parentId: nestedParentId }
      continue
    }
    if (unit.content._tag === "Entry") {
      entries.push({ ...unit.content, turnId: unit.turnId })
      items.push({
        _tag: "Entry",
        index: entries.length - 1,
        id: unit.key,
        turnId: unit.turnId,
        ...(nestedParentId === undefined ? {} : { parentId: nestedParentId }),
      })
    } else {
      blocks.push(unit.content.block)
      items.push({
        _tag: "Block",
        index: blocks.length - 1,
        id: unit.key,
        turnId: unit.turnId,
        ...(nestedParentId === undefined ? {} : { parentId: nestedParentId }),
      })
    }
    known.set(unit.key, items.length - 1)
  }
  return { ...projectedModel, entries, blocks, items }
}

export const projectUnits: {
  (model: import("./view-state").Model, units: ReadonlyArray<Unit>): import("./view-state").Model
  (units: ReadonlyArray<Unit>): (model: import("./view-state").Model) => import("./view-state").Model
} = Function.dual(2, (model: import("./view-state").Model, units: ReadonlyArray<Unit>): import("./view-state").Model =>
  projectUnitsImpl(model, units),
)

export const projectChildUnits: {
  (model: import("./view-state").Model, parentId: string, units: ReadonlyArray<Unit>): import("./view-state").Model
  (parentId: string, units: ReadonlyArray<Unit>): (model: import("./view-state").Model) => import("./view-state").Model
} = Function.dual(3, (model: import("./view-state").Model, parentId: string, units: ReadonlyArray<Unit>) =>
  projectUnitsImpl(model, units, parentId),
)
