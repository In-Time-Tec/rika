import * as TranscriptProjection from "@rika/transcript/transcript-projection"
import { childParentMatch, executionKey } from "@rika/transcript/child-parent-correlation"
import { compareUnitOrder } from "@rika/transcript/transcript-unit-order"
import type { Block } from "@rika/transcript/transcript-presentation-model"
import type { Unit } from "@rika/transcript/transcript-unit"
import type { UnitDelta } from "@rika/transcript/transcript-projection"
import { Function } from "effect"
import type { Model, TranscriptItem } from "../../state/model/terminal-state"
import { isDeliveredDelegationOutput, isFailedDelegationOutput, isSucceededDelegationOutput } from "./transcript-row"

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
interface ExecutionOutcomeSource {
  readonly owner: string
  readonly outcome: ExecutionOutcome
  readonly revision: number
}

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
const outcomeBase = new WeakMap<Block, Block>()
const outcomeSources = new WeakMap<object, ReadonlyMap<string, ExecutionOutcomeSource>>()

const applyExecutionOutcome = (model: Model, parentId: string, outcome: ExecutionOutcome): Model => {
  const blocks = [...(model.blocks as ReadonlyArray<Block>)]
  const index = blocks.findIndex(
    (block) => block._tag === "ToolCall" && block.id === parentId && block.presentation.family === "agent",
  )
  const block = blocks[index]
  if (block?._tag !== "ToolCall") return model
  const base = outcomeBase.get(block) ?? block
  if (base._tag !== "ToolCall") return model
  if (outcome.status === "complete" && isFailedDelegationOutput(base.output)) return model
  if (outcome.status === "failed" && isDeliveredDelegationOutput(base.output)) return model
  const { output: _, ...withoutOutput } = base
  const keepsOutput = outcome.reason === undefined && isSucceededDelegationOutput(base.output)
  const applied = {
    ...(keepsOutput ? base : withoutOutput),
    status: outcome.status,
    ...(outcome.reason === undefined ? {} : { output: outcome.reason }),
  }
  blocks[index] = applied
  outcomeBase.set(applied, base)
  outcomeShadow.set(base, { outcome, applied })
  return { ...model, blocks }
}

const restoreExecutionOutcome = (model: Model, parentId: string): Model => {
  const blocks = model.blocks as ReadonlyArray<Block>
  const index = blocks.findIndex(
    (block) => block._tag === "ToolCall" && block.id === parentId && block.presentation.family === "agent",
  )
  const current = blocks[index]
  if (current === undefined) return model
  const base = outcomeBase.get(current)
  if (base === undefined) return model
  const restored = [...blocks]
  restored[index] = base
  return { ...model, blocks: restored }
}

const latestOutcomeFor = (
  sources: ReadonlyMap<string, ExecutionOutcomeSource>,
  owner: string,
): ExecutionOutcome | undefined => {
  let selected: { readonly key: string; readonly source: ExecutionOutcomeSource } | undefined
  for (const [key, source] of sources) {
    if (source.owner !== owner) continue
    if (
      selected === undefined ||
      source.revision > selected.source.revision ||
      (source.revision === selected.source.revision && key > selected.key)
    )
      selected = { key, source }
  }
  return selected?.source.outcome
}

const updateExecutionOutcomes = (
  model: Model,
  units: ReadonlyArray<Unit>,
  removedKeys: ReadonlyArray<string>,
  writtenToolIds: ReadonlySet<string>,
  parentId?: string,
): Model => {
  const currentOutcomes = model.childExecutionOutcomes as Readonly<Record<string, ExecutionOutcome>>
  const currentSources = outcomeSources.get(model.childExecutionOutcomes) ?? new Map<string, ExecutionOutcomeSource>()
  let sources = currentSources
  let sourcesChanged = false
  const changedOwners = new Set<string>()
  const writeSources = () => {
    if (sourcesChanged) return sources as Map<string, ExecutionOutcomeSource>
    sources = new Map(sources)
    sourcesChanged = true
    return sources as Map<string, ExecutionOutcomeSource>
  }
  for (const key of removedKeys) {
    const previous = sources.get(key)
    if (previous === undefined) continue
    writeSources().delete(key)
    changedOwners.add(previous.owner)
  }
  for (const candidate of units) {
    const owner = parentId ?? candidate.parentId
    const previous = sources.get(candidate.key)
    if (candidate.executionOutcome === undefined || owner === undefined) {
      if (previous !== undefined) {
        writeSources().delete(candidate.key)
        changedOwners.add(previous.owner)
      }
      continue
    }
    if (
      previous?.owner === owner &&
      previous.outcome === candidate.executionOutcome &&
      previous.revision === candidate.revision
    )
      continue
    writeSources().set(candidate.key, {
      owner,
      outcome: candidate.executionOutcome,
      revision: candidate.revision,
    })
    if (previous !== undefined) changedOwners.add(previous.owner)
    changedOwners.add(owner)
  }
  for (const owner of writtenToolIds) changedOwners.add(owner)
  if (!sourcesChanged && changedOwners.size === 0) return model
  const outcomes = { ...currentOutcomes }
  let outcomesChanged = sourcesChanged
  for (const owner of changedOwners) {
    const next = latestOutcomeFor(sources, owner)
    if (next === undefined) {
      if (outcomes[owner] !== undefined) {
        delete outcomes[owner]
        outcomesChanged = true
      }
    } else if (outcomes[owner] !== next) {
      outcomes[owner] = next
      outcomesChanged = true
    }
  }
  const outcomeRecord = outcomesChanged ? outcomes : currentOutcomes
  if (sourcesChanged) outcomeSources.set(outcomeRecord, sources)
  let projected: Model = outcomesChanged ? { ...model, childExecutionOutcomes: outcomeRecord } : model
  for (const owner of changedOwners) {
    projected = restoreExecutionOutcome(projected, owner)
    const outcome = outcomes[owner]
    if (outcome !== undefined) projected = applyExecutionOutcome(projected, owner, outcome)
  }
  return projected
}

const childLabels = (name: string, presentation: ToolCall["presentation"]): ToolCall["presentation"] => ({
  ...presentation,
  ...TranscriptProjection.Presentation.agentPresentation(name),
})

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
  if (toolUnits.length === 0 && children.size === 0) return { model, units }
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

const childAgentToolBlock = (block: ChildAgentBlock): ToolCall => ({
  _tag: "ToolCall",
  id: block.id,
  name: block.name,
  input: "",
  status: block.status,
  presentation: TranscriptProjection.Presentation.agentPresentation(block.name),
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

const projectUnitsImpl = (model: Model, units: ReadonlyArray<Unit>, parentId?: string, rootTurnId?: string): Model => {
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
  const insertItem = (index: number, value: TranscriptItem) => {
    if (index === items.length) {
      writeItem(index, value)
      rememberIndex(value.id!, index)
      return
    }
    if (!itemsCloned) {
      items = [...items]
      itemsCloned = true
    }
    ;(items as Array<TranscriptItem>).splice(index, 0, value)
    known = new Map()
    for (const [position, item] of items.entries()) if (item.id !== undefined) known.set(item.id, position)
    knownCloned = true
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
  if (
    parentId !== undefined ||
    reconciled.units.some(
      (unit) =>
        unit.parentId !== undefined && unit.content._tag === "Block" && unit.content.block._tag === "ChildAgent",
    )
  )
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
      if (
        (nestedParentId !== undefined && current.parentId !== nestedParentId) ||
        (rootTurnId !== undefined && current.rootTurnId !== rootTurnId) ||
        current.order === undefined
      )
        writeItem(itemIndex!, {
          ...current,
          ...(nestedParentId === undefined ? {} : { parentId: nestedParentId }),
          ...(rootTurnId === undefined ? {} : { rootTurnId }),
          order: current.order ?? unit.order,
        })
      continue
    }
    const itemPosition = insertionPosition(items, unit, rootTurnId)
    if (unit.content._tag === "Entry") {
      const entryIndex = entries.length
      writeEntry(entryIndex, { ...unit.content, turnId: unit.turnId })
      insertItem(itemPosition, {
        _tag: "Entry",
        index: entryIndex,
        id: unit.key,
        turnId: unit.turnId,
        ...(rootTurnId === undefined ? {} : { rootTurnId }),
        ...(nestedParentId === undefined ? {} : { parentId: nestedParentId }),
        order: unit.order,
      })
    } else {
      const blockIndex = blocks.length
      writeBlock(blockIndex, unit.content.block)
      insertItem(itemPosition, {
        _tag: "Block",
        index: blockIndex,
        id: unit.key,
        turnId: unit.turnId,
        ...(rootTurnId === undefined ? {} : { rootTurnId }),
        ...(nestedParentId === undefined ? {} : { parentId: nestedParentId }),
        order: unit.order,
      })
    }
  }
  if (itemsCloned) knownIndexCache.set(items, known)
  const base =
    entriesCloned || blocksCloned || itemsCloned ? { ...projectedModel, entries, blocks, items } : projectedModel
  return updateExecutionOutcomes(base, units, [], writtenToolIds, parentId)
}

const removeUnits = (model: Model, keys: ReadonlyArray<string>): Model => {
  if (keys.length === 0) return model
  model = updateExecutionOutcomes(model, [], keys, new Set())
  const removedKeys = new Set(keys)
  const known = knownIndexesFor(model.items as ReadonlyArray<TranscriptItem>)
  const removedPositions = new Set<number>()
  const removedEntryIndexes = new Set<number>()
  const removedBlockIndexes = new Set<number>()
  const removedRowKeys = new Set<string>()
  for (const key of removedKeys) {
    const position = known.get(key)
    if (position === undefined) continue
    const item = model.items[position] as TranscriptItem | undefined
    if (item === undefined) continue
    removedPositions.add(position)
    if (item._tag === "Entry") {
      removedEntryIndexes.add(item.index)
      removedRowKeys.add(`entry:${key}`)
    } else {
      removedBlockIndexes.add(item.index)
      removedRowKeys.add(`block:${key}`)
      const block = model.blocks[item.index] as Block | undefined
      if (block?._tag === "ToolCall") removedRowKeys.add(`tool:${block.id}`)
    }
  }
  if (removedPositions.size === 0) return model
  const entryIndexes = new Map<number, number>()
  const entries = model.entries.filter((_, index) => {
    if (removedEntryIndexes.has(index)) return false
    entryIndexes.set(index, entryIndexes.size)
    return true
  })
  const blockIndexes = new Map<number, number>()
  const blocks = model.blocks.filter((_, index) => {
    if (removedBlockIndexes.has(index)) return false
    blockIndexes.set(index, blockIndexes.size)
    return true
  })
  const items: Array<TranscriptItem> = []
  for (const [position, item] of (model.items as ReadonlyArray<TranscriptItem>).entries()) {
    if (removedPositions.has(position)) continue
    const index = item._tag === "Entry" ? entryIndexes.get(item.index) : blockIndexes.get(item.index)
    if (index === undefined) continue
    items.push(index === item.index ? item : { ...item, index })
  }
  const expandedRowKeys = model.expandedRowKeys.filter((key) => !removedRowKeys.has(key))
  const detailSelection =
    model.detailSelection === undefined || !removedRowKeys.has(model.detailSelection)
      ? model.detailSelection
      : undefined
  return {
    ...model,
    entries: removedEntryIndexes.size === 0 ? model.entries : entries,
    blocks: removedBlockIndexes.size === 0 ? model.blocks : blocks,
    items,
    expandedRowKeys,
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
  (
    model: import("../../state/model/terminal-state").Model,
    units: ReadonlyArray<Unit>,
  ): import("../../state/model/terminal-state").Model
  (
    units: ReadonlyArray<Unit>,
  ): (model: import("../../state/model/terminal-state").Model) => import("../../state/model/terminal-state").Model
} = Function.dual(
  2,
  (
    model: import("../../state/model/terminal-state").Model,
    units: ReadonlyArray<Unit>,
  ): import("../../state/model/terminal-state").Model => projectUnitsImpl(model, units),
)

export const projectChildUnits: {
  (
    model: import("../../state/model/terminal-state").Model,
    parentId: string,
    units: ReadonlyArray<Unit>,
  ): import("../../state/model/terminal-state").Model
  (
    parentId: string,
    units: ReadonlyArray<Unit>,
  ): (model: import("../../state/model/terminal-state").Model) => import("../../state/model/terminal-state").Model
} = Function.dual(
  3,
  (model: import("../../state/model/terminal-state").Model, parentId: string, units: ReadonlyArray<Unit>) => {
    const projected = projectUnitsImpl(model, units, parentId)
    const parentCancelled = (projected.blocks as ReadonlyArray<Block>).some(
      (block) => block._tag === "ToolCall" && block.id === parentId && block.status === "cancelled",
    )
    if (!parentCancelled) return projected
    const childIndexes = new Set(
      (projected.items as ReadonlyArray<TranscriptItem>).flatMap((item) =>
        item._tag === "Block" && item.parentId === parentId ? [item.index] : [],
      ),
    )
    const blocks = [...(projected.blocks as ReadonlyArray<Block>)]
    for (const index of childIndexes) {
      const block = blocks[index]
      if (block === undefined) continue
      if ((block._tag !== "ToolCall" && block._tag !== "ChildAgent") || block.status !== "running") continue
      blocks[index] = { ...block, status: "cancelled" as const }
    }
    return {
      ...projected,
      blocks,
    }
  },
)
