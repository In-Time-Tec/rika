import { childParentMatch, type Block, type Unit } from "@rika/transcript"
import { Function } from "effect"
import type { Model, TranscriptItem } from "../view-state"

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
type ExecutionOutcome = NonNullable<Unit["executionOutcome"]>

const executionKey = (value: string): string => value.replace(/^execution:/, "")

const isCancellationNotice = (unit: Unit): boolean =>
  unit.key.startsWith("execution:") &&
  unit.key.endsWith(":cancelled") &&
  unit.content._tag === "Entry" &&
  unit.content.role === "notice"

const isInternalOutcome = (unit: Unit): boolean =>
  unit.key.startsWith("execution:") && unit.key.endsWith(":outcome") && unit.executionOutcome !== undefined

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

const outcomeShadow = new WeakMap<Block, { readonly outcome: ExecutionOutcome; readonly applied: Block }>()

const applyExecutionOutcome = (model: Model, parentId: string, outcome: ExecutionOutcome): Model => {
  const blocks = [...(model.blocks as ReadonlyArray<Block>)]
  const index = blocks.findIndex(
    (block) => block._tag === "ToolCall" && block.id === parentId && block.presentation.family === "agent",
  )
  const block = blocks[index]
  if (block?._tag !== "ToolCall") return model
  const { output: _, ...withoutOutput } = block
  const applied = {
    ...withoutOutput,
    status: outcome.status,
    ...(outcome.reason === undefined ? {} : { output: outcome.reason }),
  }
  blocks[index] = applied
  outcomeShadow.set(block, { outcome, applied })
  return { ...model, blocks }
}

const rememberExecutionOutcomes = (
  model: Model,
  units: ReadonlyArray<Unit>,
  writtenToolIds: ReadonlySet<string>,
  parentId?: string,
): Model => {
  const current = model.childExecutionOutcomes as Readonly<Record<string, ExecutionOutcome>>
  let outcomes = current
  let cloned = false
  const dirty = new Set<string>()
  for (const candidate of units) {
    const owner = parentId ?? candidate.parentId
    if (owner === undefined || candidate.executionOutcome === undefined) continue
    if (outcomes[owner] === candidate.executionOutcome) continue
    if (!cloned) {
      outcomes = { ...current }
      cloned = true
    }
    ;(outcomes as Record<string, ExecutionOutcome>)[owner] = candidate.executionOutcome
    dirty.add(owner)
  }
  for (const owner of Object.keys(outcomes)) if (writtenToolIds.has(owner)) dirty.add(owner)
  if (!cloned && dirty.size === 0) return model
  let projected: Model = cloned ? { ...model, childExecutionOutcomes: outcomes } : model
  for (const owner of dirty) projected = applyExecutionOutcome(projected, owner, outcomes[owner]!)
  return projected
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

const mergeChildAgentImpl = (tool: Unit, child: Unit): Unit => {
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

const mergeCache = new WeakMap<Unit, { readonly child: Unit; readonly merged: Unit }>()

const mergeChildAgent = (tool: Unit, child: Unit): Unit => {
  const cached = mergeCache.get(tool)
  if (cached !== undefined && cached.child === child) return cached.merged
  const merged = mergeChildAgentImpl(tool, child)
  mergeCache.set(tool, { child, merged })
  return merged
}

const reconcileSubagentUnits = (
  model: Model,
  units: ReadonlyArray<Unit>,
): { readonly model: Model; readonly units: ReadonlyArray<Unit> } => {
  const toolUnits: Array<Unit> = []
  const children = new Map<string, Unit>()
  const mergedRows = new Map<string, string>()
  for (const unit of units) {
    if (unit.content._tag !== "Block") continue
    const block = unit.content.block
    if (block._tag === "ToolCall") toolUnits.push(unit)
    else if (block._tag === "ChildAgent") children.set(executionKey(block.id), unit)
  }
  const toolCandidates = toolUnits.flatMap((candidate) =>
    candidate.content._tag === "Block" && candidate.content.block._tag === "ToolCall"
      ? [
          {
            id: candidate.content.block.id,
            scope: candidate.turnId,
            childId: candidate.content.block.childId,
            family: candidate.content.block.presentation.family,
            unit: candidate,
          },
        ]
      : [],
  )
  const toolForChildResults = new Map<string, Unit | undefined>()
  const toolForChild = (childId: string): Unit | undefined => {
    if (toolForChildResults.has(childId)) return toolForChildResults.get(childId)
    const found = childParentMatch(toolCandidates, childId)?.unit
    toolForChildResults.set(childId, found)
    return found
  }
  let childByToolKey: Map<string, Unit> | undefined
  const childForTool = (tool: Unit): Unit | undefined => {
    if (childByToolKey === undefined) {
      childByToolKey = new Map()
      for (const child of children.values()) {
        if (child.content._tag !== "Block" || child.content.block._tag !== "ChildAgent") continue
        const owner = toolForChild(child.content.block.id)
        if (owner !== undefined && !childByToolKey.has(owner.key)) childByToolKey.set(owner.key, child)
      }
    }
    return childByToolKey.get(tool.key)
  }
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

type ChildAgentBlock = Extract<Block, { readonly _tag: "ChildAgent" }>

const agentPresentationBase: ToolCall["presentation"] = {
  family: "agent",
  action: "task",
  activeLabel: "Subagent working",
  completeLabel: "Subagent finished",
}

const childAgentToolBlock = (block: ChildAgentBlock): ToolCall => ({
  _tag: "ToolCall",
  id: block.id,
  name: block.name,
  input: "",
  status: block.status,
  presentation: childLabels(block.name, agentPresentationBase),
  detail: block.summary,
  files: [],
  childId: block.id,
})

const mergedAgentStatus = (existing: ToolCall["status"], child: ChildAgentBlock["status"]): ToolCall["status"] =>
  child === "running" && existing !== "running" ? existing : child

const nestedChildUnit = (
  unit: Unit,
  batchToolChildIds: ReadonlySet<string>,
  batchAgentToolTokens: ReadonlySet<string>,
  existingAgentTools: ReadonlyMap<string, { readonly key: string; readonly block: ToolCall }>,
  scopeParentId: string,
): Unit | undefined => {
  if (isInternalOutcome(unit)) return undefined
  if (unit.content._tag === "Entry") return unit.content.role === "assistant" ? unit : undefined
  const block = unit.content.block
  switch (block._tag) {
    case "ToolCall":
    case "Error":
      return unit
    case "ChildAgent": {
      const childKey = executionKey(block.id)
      if (batchToolChildIds.has(childKey)) return undefined
      for (const token of batchAgentToolTokens) if (childKey.endsWith(`:${token}`)) return undefined
      const existing = existingAgentTools.get(`${scopeParentId} ${childKey}`)
      if (existing !== undefined)
        return {
          ...unit,
          key: existing.key,
          content: {
            _tag: "Block",
            block: {
              ...existing.block,
              status: mergedAgentStatus(existing.block.status, block.status),
              presentation: childLabels(block.name, existing.block.presentation),
              childId: existing.block.childId ?? block.id,
            },
          },
        }
      return { ...unit, content: { _tag: "Block", block: childAgentToolBlock(block) } }
    }
    case "Reasoning":
    case "ToolResult":
    case "Notification":
    case "Permission":
    case "Diff":
    case "ContextUsage":
    case "Compaction":
    case "Workflow":
    case "ImageAttachment":
      return undefined
    default:
      return Function.absurd(block)
  }
}

const knownIndexCache = new WeakMap<ReadonlyArray<unknown>, Map<string, number>>()

const knownIndexesFor = (items: ReadonlyArray<TranscriptItem>): Map<string, number> => {
  const cached = knownIndexCache.get(items)
  if (cached !== undefined) return cached
  const built = new Map<string, number>()
  for (const [index, item] of items.entries()) if (item.id !== undefined) built.set(item.id, index)
  knownIndexCache.set(items, built)
  return built
}

const projectUnitsImpl = (model: Model, units: ReadonlyArray<Unit>, parentId?: string): Model => {
  const parentCancelled =
    parentId !== undefined &&
    (model.blocks as ReadonlyArray<Block>).some(
      (block) => block._tag === "ToolCall" && block.id === parentId && block.status === "cancelled",
    )
  const cancellation = normalizeCancellation(parentCancelled ? units.map(cancelledUnit) : units, parentId)
  const cancellationActive = parentCancelled || cancellation.units !== units || cancellation.parentIds.size > 0
  const reconciled =
    parentId === undefined ? reconcileSubagentUnits(model, cancellation.units) : { model, units: cancellation.units }
  const projectedModel = cancelParentRows(reconciled.model, cancellation.parentIds)
  let entries = projectedModel.entries as ReadonlyArray<Model["entries"][number]>
  let blocks = projectedModel.blocks as ReadonlyArray<Block>
  let items = projectedModel.items as ReadonlyArray<TranscriptItem>
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
    ;(entries as Array<Model["entries"][number]>)[index] = value
  }
  const writeBlock = (index: number, value: Block) => {
    if (!blocksCloned) {
      blocks = [...blocks]
      blocksCloned = true
    }
    ;(blocks as Array<Block>)[index] = value
    if (value._tag === "ToolCall") writtenToolIds.add(value.id)
  }
  const writeItem = (index: number, value: TranscriptItem) => {
    if (!itemsCloned) {
      items = [...items]
      itemsCloned = true
    }
    ;(items as Array<TranscriptItem>)[index] = value
  }
  const batchToolChildIds = new Set<string>()
  const batchAgentToolTokens = new Set<string>()
  for (const candidate of reconciled.units) {
    if (candidate.content._tag !== "Block" || candidate.content.block._tag !== "ToolCall") continue
    const candidateBlock = candidate.content.block
    if (candidateBlock.childId !== undefined) batchToolChildIds.add(executionKey(candidateBlock.childId))
    if (candidateBlock.presentation.family === "agent") {
      const prefix = `${candidate.turnId}:`
      batchAgentToolTokens.add(
        candidateBlock.id.startsWith(prefix) ? candidateBlock.id.slice(prefix.length) : candidateBlock.id,
      )
    }
  }
  const existingAgentTools = new Map<string, { readonly key: string; readonly block: ToolCall }>()
  for (const item of items) {
    if (item._tag !== "Block" || item.id === undefined) continue
    const block = blocks[item.index]
    if (block?._tag !== "ToolCall" || block.presentation.family !== "agent" || block.childId === undefined) continue
    existingAgentTools.set(`${item.parentId ?? ""} ${executionKey(block.childId)}`, { key: item.id, block })
  }
  for (const rawUnit of reconciled.units) {
    if (isInternalOutcome(rawUnit)) continue
    const nestedParentId = parentId ?? rawUnit.parentId
    const unit =
      nestedParentId === undefined
        ? rawUnit
        : nestedChildUnit(rawUnit, batchToolChildIds, batchAgentToolTokens, existingAgentTools, nestedParentId)
    if (unit === undefined) continue
    const itemIndex = known.get(unit.key)
    const current = itemIndex === undefined ? undefined : items[itemIndex]
    if (current !== undefined) {
      if (unit.content._tag === "Entry" && current._tag === "Entry") {
        const stored = entries[current.index]
        const unchanged =
          !cancellationActive &&
          stored !== undefined &&
          stored.role === unit.content.role &&
          stored.text === unit.content.text &&
          stored.turnId === unit.turnId
        if (!unchanged) writeEntry(current.index, { ...unit.content, turnId: unit.turnId })
      } else if (unit.content._tag === "Block" && current._tag === "Block") {
        const stored = blocks[current.index]
        const shadow = outcomeShadow.get(unit.content.block)
        const unchanged =
          !cancellationActive && (stored === unit.content.block || (shadow !== undefined && shadow.applied === stored))
        if (!unchanged) writeBlock(current.index, unit.content.block)
      }
      if (nestedParentId !== undefined && current.parentId !== nestedParentId)
        writeItem(itemIndex!, { ...current, parentId: nestedParentId })
      continue
    }
    if (unit.content._tag === "Entry") {
      writeEntry(entries.length, { ...unit.content, turnId: unit.turnId })
      writeItem(items.length, {
        _tag: "Entry",
        index: entries.length - 1,
        id: unit.key,
        turnId: unit.turnId,
        ...(nestedParentId === undefined ? {} : { parentId: nestedParentId }),
      })
    } else {
      writeBlock(blocks.length, unit.content.block)
      writeItem(items.length, {
        _tag: "Block",
        index: blocks.length - 1,
        id: unit.key,
        turnId: unit.turnId,
        ...(nestedParentId === undefined ? {} : { parentId: nestedParentId }),
      })
    }
    rememberIndex(unit.key, items.length - 1)
  }
  if (itemsCloned) knownIndexCache.set(items, known)
  const base =
    entriesCloned || blocksCloned || itemsCloned ? { ...projectedModel, entries, blocks, items } : projectedModel
  return rememberExecutionOutcomes(base, units, writtenToolIds, parentId)
}

export const projectUnits: {
  (model: import("../view-state").Model, units: ReadonlyArray<Unit>): import("../view-state").Model
  (units: ReadonlyArray<Unit>): (model: import("../view-state").Model) => import("../view-state").Model
} = Function.dual(
  2,
  (model: import("../view-state").Model, units: ReadonlyArray<Unit>): import("../view-state").Model =>
    projectUnitsImpl(model, units),
)

export const projectChildUnits: {
  (model: import("../view-state").Model, parentId: string, units: ReadonlyArray<Unit>): import("../view-state").Model
  (
    parentId: string,
    units: ReadonlyArray<Unit>,
  ): (model: import("../view-state").Model) => import("../view-state").Model
} = Function.dual(3, (model: import("../view-state").Model, parentId: string, units: ReadonlyArray<Unit>) =>
  projectUnitsImpl(model, units, parentId),
)
