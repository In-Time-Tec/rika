import { Function } from "effect"
import { agentResponseState, isToolOutputDisplayed } from "./transcript-agent-response"
import type { Model } from "../../state/model/terminal-state"
import type { TranscriptBlock, TranscriptItem } from "../../state/model/terminal-transcript-state"
import { toolKind } from "./transcript-tool-detail"
import type {
  ToolGroupKind,
  ToolKind,
  AgentResponseState,
  ToolTranscriptUnit,
  TranscriptUnit,
  TranscriptUnitId,
} from "./transcript-tool-types"
const groupOf = (kind: ToolKind): ToolGroupKind => (kind === "read" || kind === "search" ? "explore" : kind)

export const orderedTranscriptItems = (model: Model): ReadonlyArray<TranscriptItem> =>
  model.items.length > 0
    ? (model.items as ReadonlyArray<TranscriptItem>)
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
  for (const item of model.items as ReadonlyArray<TranscriptItem>) {
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
  blocks: ReadonlyArray<unknown>,
): boolean =>
  block.presentation.rowDisplay === "continuation" &&
  (block.status !== "failed" ||
    (block.parentId !== undefined &&
      blocks.some((value) => {
        const candidate = value as TranscriptBlock
        return candidate._tag === "ToolCall" && candidate.id === block.parentId && candidate.status === "failed"
      })))

const transcriptUnitsImpl = (model: Model): ReadonlyArray<TranscriptUnit> => {
  const units: Array<TranscriptUnit> = []
  const childItems = new Map<string, Array<TranscriptItem>>()
  const cellBlockIds = new Set(
    orderedTranscriptItems(model).flatMap((item) => {
      if (item._tag !== "Block") return []
      const block = model.blocks[item.index] as TranscriptBlock
      return block._tag === "Cell" ? [block.id] : []
    }),
  )
  for (const item of orderedTranscriptItems(model)) {
    if (item.parentId === undefined) continue
    childItems.set(item.parentId, [...(childItems.get(item.parentId) ?? []), item])
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
  const nestedTools = (parentId: string): ReadonlyArray<ToolTranscriptUnit> =>
    (childItems.get(parentId) ?? []).flatMap((item) => {
      if (item._tag !== "Block") return []
      const block = model.blocks[item.index] as TranscriptBlock
      if (block._tag !== "ToolCall" || continuationIsFolded(block, model.blocks)) return []
      const children = nestedTools(block.id)
      const agentResponse = agentResponseFor(block)
      return [
        {
          kind: "tool" as const,
          group: groupOf(toolKind(block.name, block.presentation.family)),
          blocks: [item.index],
          diffs: [],
          ...(children.length === 0 ? {} : { children }),
          ...(agentResponse === undefined ? {} : { agentResponse }),
        },
      ]
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
  for (const item of orderedTranscriptItems(model)) {
    if (item.parentId !== undefined && !cellBlockIds.has(item.parentId)) continue
    if (item._tag === "Entry") {
      flush()
      units.push({ kind: "entry", entry: item.index })
      continue
    }
    const block = model.blocks[item.index] as TranscriptBlock
    if (block._tag === "ToolCall" && continuationIsFolded(block, model.blocks)) continue
    if (block._tag === "ToolCall") {
      const children = nestedTools(block.id)
      const agentResponse = agentResponseFor(block)
      if (block.presentation.outputDisplay === "inline" || children.length > 0 || agentResponse !== undefined) {
        flush()
        units.push({
          kind: "tool",
          group: groupOf(toolKind(block.name, block.presentation.family)),
          blocks: [item.index],
          diffs: [],
          ...(children.length === 0 ? {} : { children }),
          ...(agentResponse === undefined ? {} : { agentResponse }),
        })
        continue
      }
      toolRun.push({ index: item.index, kind: toolKind(block.name, block.presentation.family) })
      continue
    }
    if (block._tag === "ToolResult") continue
    if (block._tag === "Diff" && toolRun.length > 0 && toolRun.at(-1)!.kind === "edit") {
      pendingEditDiffs.push(item.index)
      continue
    }
    flush()
    if (block._tag === "Reasoning") units.push({ kind: "reasoning", block: item.index })
    else if (block._tag === "SubagentCard") {
      const agentResponse = subagentResponseFor(block)
      units.push({
        kind: "subagent",
        block: item.index,
        children: nestedTools(block.id),
        ...(agentResponse === undefined ? {} : { agentResponse }),
      })
    } else if (block._tag === "Diff") units.push({ kind: "diff", block: item.index })
    else if (block._tag === "Cell") units.push({ kind: "cell", block: item.index })
    else units.push({ kind: "block", block: item.index })
  }
  flush()
  return units
}

export const isExpandableUnit: {
  (model: Model, unit: TranscriptUnit): boolean
  (unit: TranscriptUnit): (model: Model) => boolean
} = Function.dual(2, (model: Model, unit: TranscriptUnit): boolean => {
  if (unit.kind !== "tool") {
    if (unit.kind === "block") {
      const block = model.blocks[unit.block] as TranscriptBlock
      return (
        (block._tag === "Error" && block.detail.length > 0) ||
        (block._tag === "AuthorizationCard" && (block.status === "pending" || block.input.length > 0))
      )
    }
    if (unit.kind === "cell") {
      const block = model.blocks[unit.block] as Extract<TranscriptBlock, { _tag: "Cell" }>
      return (
        block.source.text.length > 0 ||
        block.output.stdout.length > 0 ||
        block.output.stderr.length > 0 ||
        block.result !== undefined ||
        block.error !== undefined ||
        block.notices.length > 0
      )
    }
    return unit.kind === "reasoning" || unit.kind === "diff" || unit.kind === "subagent"
  }
  if ((unit.children?.length ?? 0) > 0 || unit.agentResponse !== undefined) return true
  if (unit.group === "explore" || unit.group === "edit" || (unit.group === "shell" && unit.blocks.length > 1))
    return true
  return unit.blocks.some((index) => {
    const block = model.blocks[index] as Extract<TranscriptBlock, { _tag: "ToolCall" }>
    return (
      (block.presentation.family === "agent" && (block.status === "running" || block.detail.length > 0)) ||
      (block.presentation.outputDisplay !== "inline" &&
        isToolOutputDisplayed(block) &&
        block.output !== undefined &&
        block.output.length > 0)
    )
  })
})

export const expandableUnits = (model: Model): ReadonlyArray<TranscriptUnit> =>
  transcriptUnits(model).filter((unit) => isExpandableUnit(model, unit))

export const expandableRowIds = (model: Model): ReadonlyArray<TranscriptUnitId> => {
  const ids: Array<TranscriptUnitId> = []
  const expanded = new Set(model.expandedRowKeys)
  const appendTool = (unit: ToolTranscriptUnit) => {
    if (!isExpandableUnit(model, unit)) return
    const id = transcriptUnitId(model, unit)
    ids.push(id)
    if (!expanded.has(id)) return
    for (const child of unit.children ?? []) appendTool(child)
    if (unit.group === "edit") {
      const files = unit.blocks.flatMap((index) => {
        const block = model.blocks[index] as Extract<TranscriptBlock, { _tag: "ToolCall" }>
        return block.files
      })
      if (files.length > 1) for (const file of files) ids.push(`file:${file.key}`)
      return
    }
    if ((unit.group === "shell" && unit.blocks.length > 1) || unit.group === "explore")
      for (const index of unit.blocks) {
        const block = model.blocks[index] as Extract<TranscriptBlock, { _tag: "ToolCall" }>
        if (isToolOutputDisplayed(block) && block.output !== undefined && block.output.length > 0)
          ids.push(`tool-child:${block.id}`)
      }
  }
  for (const unit of expandableUnits(model)) {
    if (unit.kind === "tool") appendTool(unit)
    else ids.push(transcriptUnitId(model, unit))
  }
  return ids
}

export const transcriptUnitId: {
  (model: Model, unit: TranscriptUnit): TranscriptUnitId
  (unit: TranscriptUnit): (model: Model) => TranscriptUnitId
} = Function.dual(2, (model: Model, unit: TranscriptUnit): TranscriptUnitId => {
  const cache = rowsCacheFor(model)
  if (unit.kind === "entry") {
    const entry = model.entries[unit.entry]
    const item =
      cache !== undefined
        ? cache.entryItemByIndex.get(unit.entry)
        : orderedTranscriptItems(model).find(
            (candidate) => candidate._tag === "Entry" && candidate.index === unit.entry,
          )
    return `entry:${item?.id ?? `${entry?.turnId ?? "missing"}:${entry?.role ?? "entry"}:${unit.entry}`}`
  }
  if (unit.kind === "subagent") {
    const block = model.blocks[unit.block] as Extract<TranscriptBlock, { _tag: "SubagentCard" }>
    return `subagent:${block.id}`
  }
  if (unit.kind === "cell") {
    const block = model.blocks[unit.block] as Extract<TranscriptBlock, { _tag: "Cell" }>
    return `cell:${block.id}`
  }
  if (unit.kind === "tool") {
    const block = model.blocks[unit.blocks[0]!] as Extract<TranscriptBlock, { _tag: "ToolCall" }>
    return `tool:${block.id}`
  }
  const block = model.blocks[unit.block] as TranscriptBlock
  const item =
    cache !== undefined
      ? cache.blockItemByIndex.get(unit.block)
      : orderedTranscriptItems(model).find((candidate) => candidate._tag === "Block" && candidate.index === unit.block)
  if (item?.id !== undefined) return `block:${item.id}`
  if ("id" in block && typeof block.id === "string") return `block:${block.id}`
  return `block:${block._tag}:${unit.block}`
})

export const unitToggleTargets = (unit: TranscriptUnit): ReadonlyArray<number> => {
  if (unit.kind === "tool") return unit.blocks
  if (unit.kind === "reasoning" || unit.kind === "diff" || unit.kind === "cell") return [unit.block]
  return []
}
