import * as TranscriptPresentationModel from "@rika/transcript/transcript-presentation-model"
import * as TranscriptUnitModel from "@rika/transcript/transcript-unit"
import { Function, Schema } from "effect"
import { agentResponseState, isToolOutputDisplayed } from "./agent-response"
import { toolResultText } from "./tool/body"
import type { Model } from "../../state/model"
import type { TranscriptBlock, TranscriptItem } from "../../state/transcript/model"
import { toolKind } from "./tool/detail"
import type { NestedTranscriptUnit, TranscriptUnit, TranscriptUnitId } from "./tool/types"
import type { ToolGroupKind, ToolKind, AgentResponseState } from "./tool/kinds"
const groupOf = (kind: ToolKind): ToolGroupKind => (kind === "read" || kind === "search" ? "explore" : kind)

const TranscriptItemSchema = Schema.Union([
  Schema.TaggedStruct("Entry", {
    index: Schema.Finite,
    id: Schema.optionalKey(Schema.String),
    turnId: Schema.optionalKey(Schema.String),
    rootTurnId: Schema.optionalKey(Schema.String),
    parentId: Schema.optionalKey(Schema.String),
    order: Schema.optionalKey(TranscriptUnitModel.UnitOrder),
  }),
  Schema.TaggedStruct("Block", {
    index: Schema.Finite,
    id: Schema.optionalKey(Schema.String),
    turnId: Schema.optionalKey(Schema.String),
    rootTurnId: Schema.optionalKey(Schema.String),
    parentId: Schema.optionalKey(Schema.String),
    order: Schema.optionalKey(TranscriptUnitModel.UnitOrder),
  }),
])
const decodeTranscriptItems = Schema.decodeUnknownSync(Schema.Array(TranscriptItemSchema))
const decodeTranscriptBlock = Schema.decodeUnknownSync(TranscriptPresentationModel.Block)
const decodedItemsCache = new WeakMap<ReadonlyArray<unknown>, ReadonlyArray<TranscriptItem>>()
const transcriptItems = (items: ReadonlyArray<unknown>): ReadonlyArray<TranscriptItem> => {
  const cached = decodedItemsCache.get(items)
  if (cached !== undefined) return cached
  const decoded = decodeTranscriptItems(items)
  decodedItemsCache.set(items, decoded)
  decodedItemsCache.set(decoded, decoded)
  return decoded
}

export const orderedTranscriptItems = (model: Model): ReadonlyArray<TranscriptItem> =>
  model.items.length > 0
    ? transcriptItems(model.items)
    : [
        ...model.entries.map((_, index) => ({ _tag: "Entry" as const, index })),
        ...model.blocks.map((_, index) => ({ _tag: "Block" as const, index })),
      ]

interface RowsCache {
  readonly blocks: ReadonlyArray<unknown>
  readonly entries: ReadonlyArray<unknown>
  readonly entryItemByIndex: ReadonlyMap<number, TranscriptItem>
  readonly blockItemByIndex: ReadonlyMap<number, TranscriptItem>
  units?: ReadonlyArray<TranscriptUnit>
}

const rowsCacheByItems = new WeakMap<ReadonlyArray<unknown>, RowsCache>()

const rowsCacheFor = (model: Model): RowsCache | undefined => {
  if (model.items.length === 0) return undefined
  const cached = rowsCacheByItems.get(model.items)
  if (cached !== undefined && cached.blocks === model.blocks && cached.entries === model.entries) return cached
  const entryItemByIndex = new Map<number, TranscriptItem>()
  const blockItemByIndex = new Map<number, TranscriptItem>()
  for (const item of transcriptItems(model.items)) {
    const byIndex = item._tag === "Entry" ? entryItemByIndex : blockItemByIndex
    if (!byIndex.has(item.index)) byIndex.set(item.index, item)
  }
  const built: RowsCache = {
    blocks: model.blocks,
    entries: model.entries,
    entryItemByIndex,
    blockItemByIndex,
  }
  rowsCacheByItems.set(model.items, built)
  return built
}

export const transcriptUnits = (model: Model): ReadonlyArray<TranscriptUnit> => {
  const cache = rowsCacheFor(model)
  if (cache?.units !== undefined) return cache.units
  const units = transcriptUnitsImpl(model)
  if (cache !== undefined) cache.units = units
  return units
}

const continuationIsFolded = (
  block: Extract<TranscriptBlock, { _tag: "ToolCall" }>,
  blocks: Model["blocks"],
): boolean =>
  block.presentation.rowDisplay === "continuation" &&
  block.presentation.action !== "status" &&
  (block.status !== "failed" ||
    (block.parentId !== undefined &&
      blocks.some((value) => {
        const candidate = decodeTranscriptBlock(value)
        return candidate._tag === "ToolCall" && candidate.id === block.parentId && candidate.status === "failed"
      })))

const toolUnitHasStructuralDetail = (unit: Extract<TranscriptUnit, { kind: "tool" }>): boolean =>
  (unit.children?.length ?? 0) > 0 ||
  unit.agentResponse !== undefined ||
  (unit.group === "explore" && unit.blocks.length > 1) ||
  unit.group === "edit" ||
  (unit.group === "shell" && unit.blocks.length > 1)

const toolIsStandalone = (
  block: Extract<TranscriptBlock, { _tag: "ToolCall" }>,
  children: ReadonlyArray<NestedTranscriptUnit>,
  response: AgentResponseState | undefined,
): boolean => block.presentation.outputDisplay === "inline" || children.length > 0 || response !== undefined

/** Nested units point at their parent's block id (not its unit key), so collect loaded block ids. */
const loadedBlockId = (model: Model, item: TranscriptItem): ReadonlyArray<string> => {
  if (item._tag !== "Block") return []
  const block = decodeTranscriptBlock(model.blocks[item.index])
  return "id" in block ? [block.id] : []
}

const transcriptUnitsImpl = (model: Model): ReadonlyArray<TranscriptUnit> => {
  const units: Array<TranscriptUnit> = []
  const childItems = new Map<string, Array<TranscriptItem>>()
  const items = orderedTranscriptItems(model)
  let loadedBlockIds: Set<string> | undefined
  const blockIsLoaded = (id: string): boolean => {
    loadedBlockIds ??= new Set(items.flatMap((item) => loadedBlockId(model, item)))
    return loadedBlockIds.has(id)
  }
  // A child whose parent is not loaded renders at the top level instead of disappearing.
  const parentOf = (item: TranscriptItem): string | undefined =>
    item.parentId !== undefined && blockIsLoaded(item.parentId) ? item.parentId : undefined
  for (const item of items) {
    const parentId = parentOf(item)
    if (parentId === undefined) continue
    const children = childItems.get(parentId)
    if (children === undefined) childItems.set(parentId, [item])
    else children.push(item)
  }
  const subagentResponseFor = (
    block: Extract<TranscriptBlock, { _tag: "SubagentCard" }>,
  ): AgentResponseState | undefined => {
    const children = childItems.get(block.id) ?? []
    const answer = children.findLast(
      (item) =>
        item._tag === "Entry" &&
        model.entries[item.index]?.role === "assistant" &&
        (model.entries[item.index]?.text.trim().length ?? 0) > 0,
    )
    if (block.status === "running" || block.status === "waiting" || block.status === "cancelling")
      return answer?.index === undefined ? undefined : { _tag: "Streaming", answer: answer.index }
    if (answer?.index !== undefined) return { _tag: "Settled", outcome: { kind: "answer", entry: answer.index } }
    if (block.status === "failed")
      return {
        _tag: "Settled",
        outcome: { kind: "error", tone: "failed", text: block.summary || "The subagent failed." },
      }
    if (block.status === "cancelled")
      return {
        _tag: "Settled",
        outcome: { kind: "error", tone: "cancelled", text: block.summary || "The subagent was cancelled." },
      }
    return {
      _tag: "Settled",
      outcome: { kind: "error", tone: "info", text: block.summary || "The subagent finished without a final message." },
    }
  }
  const agentResponseFor = (block: Extract<TranscriptBlock, { _tag: "ToolCall" }>): AgentResponseState | undefined =>
    block.presentation.family === "agent" ? agentResponseState(model, block, childItems.get(block.id) ?? []) : undefined
  const nestedUnits = (parentId: string): ReadonlyArray<NestedTranscriptUnit> =>
    (childItems.get(parentId) ?? []).flatMap((item): ReadonlyArray<NestedTranscriptUnit> => {
      if (item._tag !== "Block") return []
      const block = decodeTranscriptBlock(model.blocks[item.index])
      if (block._tag === "SubagentGroup")
        return [{ kind: "subagent-group", block: item.index, children: nestedUnits(block.id) }]
      if (block._tag === "SubagentCard") {
        const children = nestedUnits(block.id)
        const agentResponse = subagentResponseFor(block)
        return agentResponse === undefined
          ? [{ kind: "subagent", block: item.index, children }]
          : [{ kind: "subagent", block: item.index, children, agentResponse }]
      }
      if (block._tag !== "ToolCall" || continuationIsFolded(block, model.blocks)) return []
      const children = nestedUnits(block.id)
      const agentResponse = agentResponseFor(block)
      const base = {
        kind: "tool" as const,
        group: groupOf(toolKind(block.name, block.presentation.family)),
        blocks: [item.index],
        diffs: [],
      }
      if (children.length === 0) return agentResponse === undefined ? [base] : [{ ...base, agentResponse }]
      return agentResponse === undefined ? [{ ...base, children }] : [{ ...base, children, agentResponse }]
    })
  let toolRun: Array<{ readonly index: number; readonly kind: ToolKind }> = []
  let pendingEditDiffs: Array<number> = []
  const flush = () => {
    if (toolRun.length === 0) return
    const diffs = pendingEditDiffs
    pendingEditDiffs = []
    let editDiffsConsumed = false
    let cursor = 0
    while (cursor < toolRun.length) {
      const group = groupOf(toolRun[cursor]!.kind)
      const members: Array<number> = []
      while (cursor < toolRun.length && groupOf(toolRun[cursor]!.kind) === group) {
        members.push(toolRun[cursor]!.index)
        cursor += 1
      }
      if (group === "other")
        for (const block of members) units.push({ kind: "tool", group, blocks: [block], diffs: [] })
      else if (group === "edit") {
        units.push({ kind: "tool", group, blocks: members, diffs: editDiffsConsumed ? [] : diffs })
        editDiffsConsumed = true
      } else units.push({ kind: "tool", group, blocks: members, diffs: [] })
    }
    toolRun = []
  }
  const appendTopLevelItem = (item: TranscriptItem) => {
    if (parentOf(item) !== undefined) return
    if (item._tag === "Entry") {
      flush()
      units.push({ kind: "entry", entry: item.index })
      return
    }
    const block = decodeTranscriptBlock(model.blocks[item.index])
    if (block._tag === "ToolCall" && continuationIsFolded(block, model.blocks)) return
    if (block._tag === "ToolCall") {
      const children = nestedUnits(block.id)
      const agentResponse = agentResponseFor(block)
      if (toolIsStandalone(block, children, agentResponse)) {
        flush()
        const base: TranscriptUnit = {
          kind: "tool",
          group: groupOf(toolKind(block.name, block.presentation.family)),
          blocks: [item.index],
          diffs: [],
        }
        if (children.length === 0) units.push(agentResponse === undefined ? base : { ...base, agentResponse })
        else units.push(agentResponse === undefined ? { ...base, children } : { ...base, children, agentResponse })
        return
      }
      toolRun.push({ index: item.index, kind: toolKind(block.name, block.presentation.family) })
      return
    }
    if (block._tag === "ToolResult") return
    if (block._tag === "Diff" && toolRun.length > 0 && toolRun.at(-1)!.kind === "edit") {
      pendingEditDiffs.push(item.index)
      return
    }
    flush()
    appendPresentedBlock(item.index, block)
  }
  const appendPresentedBlock = (index: number, block: TranscriptBlock) => {
    if (block._tag === "Reasoning") units.push({ kind: "reasoning", block: index })
    else if (block._tag === "SubagentGroup")
      units.push({ kind: "subagent-group", block: index, children: nestedUnits(block.id) })
    else if (block._tag === "SubagentCard") {
      const agentResponse = subagentResponseFor(block)
      const children = nestedUnits(block.id)
      units.push(
        agentResponse === undefined
          ? { kind: "subagent", block: index, children }
          : { kind: "subagent", block: index, children, agentResponse },
      )
    } else if (block._tag === "Diff") units.push({ kind: "diff", block: index })
    else units.push({ kind: "block", block: index })
  }
  for (const item of orderedTranscriptItems(model)) appendTopLevelItem(item)
  flush()
  return units
}

const isAutoExpandedUnitImpl = (model: Model, unit: TranscriptUnit): boolean => {
  if (unit.kind === "subagent-group") {
    const block = decodeTranscriptBlock(model.blocks[unit.block])
    return block._tag === "SubagentGroup" && (block.status === "running" || block.status === "cancelling")
  }
  if (unit.kind === "subagent") {
    const block = decodeTranscriptBlock(model.blocks[unit.block])
    return (
      block._tag === "SubagentCard" &&
      (block.status === "running" || block.status === "waiting" || block.status === "cancelling")
    )
  }
  if (unit.kind !== "tool") return false
  return unit.blocks.some((index) => {
    const block = decodeTranscriptBlock(model.blocks[index])
    return block._tag === "ToolCall" && block.status === "running" && unit.group === "edit"
  })
}

export const isAutoExpandedUnit: {
  (unit: TranscriptUnit): (model: Model) => boolean
  (model: Model, unit: TranscriptUnit): boolean
} = Function.dual(2, isAutoExpandedUnitImpl)

const isTranscriptUnitExpandedImpl = (model: Model, unit: TranscriptUnit): boolean => {
  const id = transcriptUnitId(model, unit)
  if (model.explicitlyCollapsedRowKeys.includes(id)) return false
  return model.expandedRowKeys.includes(id) || isAutoExpandedUnit(model, unit)
}

export const isTranscriptUnitExpanded: {
  (unit: TranscriptUnit): (model: Model) => boolean
  (model: Model, unit: TranscriptUnit): boolean
} = Function.dual(2, isTranscriptUnitExpandedImpl)

export const isExpandableUnit: {
  (model: Model, unit: TranscriptUnit): boolean
  (unit: TranscriptUnit): (model: Model) => boolean
} = Function.dual(2, (model: Model, unit: TranscriptUnit): boolean => {
  if (unit.kind !== "tool") {
    if (unit.kind === "block") {
      const block = decodeTranscriptBlock(model.blocks[unit.block])
      return block._tag === "AuthorizationCard" && (block.status === "pending" || block.input.length > 0)
    }
    return unit.kind === "diff" || unit.kind === "subagent" || unit.kind === "subagent-group"
  }
  if (toolUnitHasStructuralDetail(unit)) return true
  return unit.blocks.some((index) => {
    const block = decodeTranscriptBlock(model.blocks[index])
    if (block._tag !== "ToolCall") return false
    return (
      (block.presentation.family === "agent" && (block.status === "running" || block.detail.length > 0)) ||
      (block.presentation.outputDisplay !== "inline" &&
        isToolOutputDisplayed(block) &&
        (toolResultText(block.result)?.length ?? 0) > 0)
    )
  })
})

export const expandableUnits = (model: Model): ReadonlyArray<TranscriptUnit> =>
  transcriptUnits(model).filter((unit) => isExpandableUnit(model, unit))

const appendToolChildRowIds = (
  model: Model,
  unit: Extract<NestedTranscriptUnit, { kind: "tool" }>,
  ids: Array<TranscriptUnitId>,
) => {
  if (unit.group === "edit") {
    const files = unit.blocks.flatMap((index) => {
      const block = decodeTranscriptBlock(model.blocks[index])
      return block._tag === "ToolCall" ? block.files : []
    })
    if (files.length > 1) for (const file of files) ids.push(`file:${file.key}`)
    return
  }
  if (!((unit.group === "shell" && unit.blocks.length > 1) || (unit.group === "explore" && unit.blocks.length > 1)))
    return
  for (const index of unit.blocks) {
    const block = decodeTranscriptBlock(model.blocks[index])
    if (block._tag !== "ToolCall") continue
    if (isToolOutputDisplayed(block) && (toolResultText(block.result)?.length ?? 0) > 0)
      ids.push(`tool-child:${block.id}`)
  }
}

export const expandableRowIds = (model: Model): ReadonlyArray<TranscriptUnitId> => {
  const ids: Array<TranscriptUnitId> = []
  const appendNested = (unit: NestedTranscriptUnit) => {
    if (!isExpandableUnit(model, unit)) return
    const id = transcriptUnitId(model, unit)
    ids.push(id)
    if (!isTranscriptUnitExpanded(model, unit)) return
    for (const child of unit.children ?? []) appendNested(child)
    if (unit.kind === "subagent" || unit.kind === "subagent-group") return
    appendToolChildRowIds(model, unit, ids)
  }
  for (const unit of expandableUnits(model)) {
    if (unit.kind === "tool") appendNested(unit)
    else {
      const id = transcriptUnitId(model, unit)
      ids.push(id)
      if ((unit.kind === "subagent" || unit.kind === "subagent-group") && isTranscriptUnitExpanded(model, unit))
        for (const child of unit.children) appendNested(child)
    }
  }
  return ids
}

const entryUnitId = (
  model: Model,
  unit: Extract<TranscriptUnit, { kind: "entry" }>,
  cache: RowsCache | undefined,
): TranscriptUnitId => {
  const entry = model.entries[unit.entry]
  const item =
    cache !== undefined
      ? cache.entryItemByIndex.get(unit.entry)
      : orderedTranscriptItems(model).find((candidate) => candidate._tag === "Entry" && candidate.index === unit.entry)
  return `entry:${item?.id ?? `${entry?.turnId ?? "missing"}:${entry?.role ?? "entry"}:${unit.entry}`}`
}

const blockUnitId = (model: Model, blockIndex: number, cache: RowsCache | undefined): TranscriptUnitId => {
  const block = decodeTranscriptBlock(model.blocks[blockIndex])
  const item =
    cache !== undefined
      ? cache.blockItemByIndex.get(blockIndex)
      : orderedTranscriptItems(model).find((candidate) => candidate._tag === "Block" && candidate.index === blockIndex)
  if (item?.id !== undefined) return `block:${item.id}`
  if ("id" in block) return `block:${block.id}`
  return `block:${block._tag}:${blockIndex}`
}

export const transcriptUnitId: {
  (model: Model, unit: TranscriptUnit): TranscriptUnitId
  (unit: TranscriptUnit): (model: Model) => TranscriptUnitId
} = Function.dual(2, (model: Model, unit: TranscriptUnit): TranscriptUnitId => {
  const cache = rowsCacheFor(model)
  if (unit.kind === "entry") return entryUnitId(model, unit, cache)
  if (unit.kind === "subagent-group") {
    const block = decodeTranscriptBlock(model.blocks[unit.block])
    return block._tag === "SubagentGroup" ? `subagent-group:${block.id}` : `subagent-group:missing:${unit.block}`
  }
  if (unit.kind === "subagent") {
    const block = decodeTranscriptBlock(model.blocks[unit.block])
    return block._tag === "SubagentCard" ? `subagent:${block.id}` : `subagent:missing:${unit.block}`
  }
  if (unit.kind === "tool") {
    const first = unit.blocks[0]
    if (first === undefined) return "tool:missing"
    const block = decodeTranscriptBlock(model.blocks[first])
    return block._tag === "ToolCall" ? `tool:${block.id}` : `tool:missing:${first}`
  }
  return blockUnitId(model, unit.block, cache)
})

export const unitToggleTargets = (unit: TranscriptUnit): ReadonlyArray<number> => {
  if (unit.kind === "tool") return unit.blocks
  if (unit.kind === "reasoning" || unit.kind === "diff") return [unit.block]
  return []
}
