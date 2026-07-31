import * as TranscriptProjection from "@rika/transcript/transcript-projection"
import { childParentMatch, executionKey } from "@rika/transcript/child-parent-correlation"
import { Function } from "effect"
import type { Block } from "@rika/transcript/transcript-presentation-model"
import type { Unit } from "@rika/transcript/transcript-unit"
import type { Model, TranscriptItem } from "../../state/model/terminal-state"

type ToolCall = Extract<Block, { readonly _tag: "ToolCall" }>

export const isInternalOutcome = (unit: Unit): boolean =>
  unit.key.startsWith("execution:") && unit.key.endsWith(":outcome") && unit.executionOutcome !== undefined
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

export const reconcileSubagentUnits = (
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

export const nestedChildUnit = (
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
