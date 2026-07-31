import { Function } from "effect"
import type { Model, TranscriptBlock, TranscriptItem } from "../../state/model/terminal-state"
import {
  agentToolSummary,
  escapePathTarget,
  toolDetail,
  toolDetails,
  toolKind,
  type ToolGroupKind,
  type ToolKind,
  type ToolDetail,
  type ToolSummary,
  type PathTarget,
  type AgentOutcome,
  type AgentResponseState,
  type ToolTranscriptUnit,
  type TranscriptUnit,
  type TranscriptUnitId,
} from "./transcript-tool-detail"
export { agentToolSummary, escapePathTarget, toolDetail, toolDetails, toolKind }
export type {
  ToolGroupKind,
  ToolKind,
  ToolDetail,
  ToolSummary,
  PathTarget,
  AgentOutcome,
  AgentResponseState,
  ToolTranscriptUnit,
  TranscriptUnit,
  TranscriptUnitId,
} from "./transcript-tool-detail"
const groupOf = (kind: ToolKind): ToolGroupKind => (kind === "read" || kind === "search" ? "explore" : kind)

const agentFailureFallback = "The subagent failed without a reported reason."
const agentEmptyFallback = "The subagent finished without a final message."
const agentCancelledFallback = "The subagent was cancelled."

const stringField = (value: object, key: string): string | undefined => {
  if (!(key in value)) return undefined
  const field = (value as Record<string, unknown>)[key]
  return typeof field === "string" && field.trim().length > 0 ? field : undefined
}

const decodedOutput = (output: string | undefined): object | undefined => {
  if (output === undefined) return undefined
  const value = output.trim()
  if (!(value.startsWith("{") || value.startsWith("["))) return undefined
  try {
    const decoded: unknown = JSON.parse(value)
    return typeof decoded === "object" && decoded !== null ? decoded : undefined
  } catch {
    return undefined
  }
}

const failedDelegationTags = new Set(["NoReport", "Failed"])

export const isFailedDelegationOutput = (output: string | undefined): boolean => {
  const decoded = decodedOutput(output)
  if (decoded === undefined) return false
  const tag = stringField(decoded, "_tag")
  return tag !== undefined && failedDelegationTags.has(tag) && stringField(decoded, "status") === "failed"
}

export const isDeliveredDelegationOutput = (output: string | undefined): boolean => {
  const decoded = decodedOutput(output)
  if (decoded === undefined) return false
  return stringField(decoded, "_tag") === "Report" && stringField(decoded, "status") === "completed"
}

const succeededDelegationTags = new Set(["Report", "NoReport"])

export const isSucceededDelegationOutput = (output: string | undefined): boolean => {
  const decoded = decodedOutput(output)
  if (decoded === undefined) return false
  const tag = stringField(decoded, "_tag")
  return tag !== undefined && succeededDelegationTags.has(tag) && stringField(decoded, "status") === "completed"
}

const noReportText = (decoded: object): string | undefined => {
  if (stringField(decoded, "_tag") !== "NoReport") return undefined
  const reason = stringField(decoded, "reason") ?? agentEmptyFallback
  const recovery = stringField(decoded, "recovery")
  return recovery === undefined ? reason : `${reason}\n\n${recovery}`
}

export const agentOutputText = (output: string | undefined): string | undefined => {
  if (output === undefined) return undefined
  const value = output.trim()
  if (value.length === 0) return undefined
  const decoded = decodedOutput(output)
  if (decoded === undefined) return output
  const noReport = noReportText(decoded)
  if (noReport !== undefined) return noReport
  if ("output" in decoded && Array.isArray((decoded as { readonly output: unknown }).output)) {
    const text = (decoded as { readonly output: ReadonlyArray<unknown> }).output
      .flatMap((part) =>
        typeof part === "object" &&
        part !== null &&
        "text" in part &&
        typeof (part as { text: unknown }).text === "string"
          ? [(part as { readonly text: string }).text]
          : [],
      )
      .join("\n")
    const reason = stringField(decoded, "reason")
    if (text.trim().length > 0) return reason === undefined ? text : `${text}\n\n${reason}`
    if (reason !== undefined) return reason
  }
  return undefined
}

const lastAnswerEntry = (model: Model, children: ReadonlyArray<TranscriptItem>): number | undefined =>
  children.findLast(
    (item): item is Extract<TranscriptItem, { readonly _tag: "Entry" }> =>
      item._tag === "Entry" &&
      model.entries[item.index]?.role === "assistant" &&
      (model.entries[item.index]?.text.trim().length ?? 0) > 0,
  )?.index

const childErrorDetail = (model: Model, children: ReadonlyArray<TranscriptItem>): string | undefined => {
  const item = children.findLast(
    (candidate): candidate is Extract<TranscriptItem, { readonly _tag: "Block" }> =>
      candidate._tag === "Block" && (model.blocks[candidate.index] as TranscriptBlock | undefined)?._tag === "Error",
  )
  if (item === undefined) return undefined
  const block = model.blocks[item.index] as Extract<TranscriptBlock, { _tag: "Error" }>
  const detail = block.detail.trim().length > 0 ? block.detail : block.title
  return detail.trim().length > 0 ? detail : undefined
}

const outcomeReason = (model: Model, block: Extract<TranscriptBlock, { _tag: "ToolCall" }>): string | undefined => {
  const outcomes = model.childExecutionOutcomes as Readonly<Record<string, { readonly reason?: string }>>
  const reason = outcomes[block.id]?.reason
  return reason !== undefined && reason.trim().length > 0 ? reason : undefined
}

const settledText = (
  model: Model,
  block: Extract<TranscriptBlock, { _tag: "ToolCall" }>,
  children: ReadonlyArray<TranscriptItem>,
  fallback: string,
): string =>
  (block.status === "complete" && isDeliveredDelegationOutput(block.output)
    ? agentOutputText(block.output)
    : undefined) ??
  childErrorDetail(model, children) ??
  outcomeReason(model, block) ??
  (isToolOutputDisplayed(block) ? agentOutputText(block.output) : undefined) ??
  fallback

export const agentResponseState: {
  (
    model: Model,
    block: Extract<TranscriptBlock, { _tag: "ToolCall" }>,
    children: ReadonlyArray<TranscriptItem>,
  ): AgentResponseState | undefined
  (
    block: Extract<TranscriptBlock, { _tag: "ToolCall" }>,
    children: ReadonlyArray<TranscriptItem>,
  ): (model: Model) => AgentResponseState | undefined
} = Function.dual(
  3,
  (
    model: Model,
    block: Extract<TranscriptBlock, { _tag: "ToolCall" }>,
    children: ReadonlyArray<TranscriptItem>,
  ): AgentResponseState | undefined => {
    const answer = lastAnswerEntry(model, children)
    if (block.status === "running") return answer === undefined ? undefined : { _tag: "Streaming", answer }
    if (block.status === "failed") {
      return {
        _tag: "Settled",
        outcome: { kind: "error", tone: "failed", text: settledText(model, block, children, agentFailureFallback) },
      }
    }
    if (answer !== undefined) return { _tag: "Settled", outcome: { kind: "answer", entry: answer } }
    if (block.status === "complete") {
      return {
        _tag: "Settled",
        outcome: { kind: "error", tone: "info", text: settledText(model, block, children, agentEmptyFallback) },
      }
    }
    return {
      _tag: "Settled",
      outcome: {
        kind: "error",
        tone: "cancelled",
        text: settledText(model, block, children, agentCancelledFallback),
      },
    }
  },
)

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
  for (const item of orderedTranscriptItems(model)) {
    if (item.parentId === undefined) continue
    childItems.set(item.parentId, [...(childItems.get(item.parentId) ?? []), item])
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
    if (item.parentId !== undefined) continue
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
    else if (block._tag === "ChildAgent") units.push({ kind: "childAgent", block: item.index })
    else if (block._tag === "Diff") units.push({ kind: "diff", block: item.index })
    else units.push({ kind: "block", block: item.index })
  }
  flush()
  return units
}

export const isToolOutputDisplayed = (block: Extract<TranscriptBlock, { _tag: "ToolCall" }>): boolean =>
  block.status === "failed" || block.presentation.outputDisplay !== "hidden"

export const isExpandableUnit: {
  (model: Model, unit: TranscriptUnit): boolean
  (unit: TranscriptUnit): (model: Model) => boolean
} = Function.dual(2, (model: Model, unit: TranscriptUnit): boolean => {
  if (unit.kind !== "tool") return unit.kind === "reasoning" || unit.kind === "diff" || unit.kind === "childAgent"
  if ((unit.children?.length ?? 0) > 0 || unit.agentResponse !== undefined) return true
  if (unit.group === "explore" || unit.group === "edit" || (unit.group === "shell" && unit.blocks.length > 1))
    return true
  return unit.blocks.some((index) => {
    const block = model.blocks[index] as Extract<TranscriptBlock, { _tag: "ToolCall" }>
    return (
      (block.presentation.family === "agent" && block.detail.length > 0) ||
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
    if (unit.group === "shell" && unit.blocks.length > 1)
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
    return `entry:${item?.id ?? `${entry?.turnId ?? "legacy"}:${entry?.role ?? "entry"}:${unit.entry}`}`
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
  if (unit.kind === "reasoning" || unit.kind === "diff") return [unit.block]
  return []
}
