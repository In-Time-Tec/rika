import { Function, Option, Schema } from "effect"
import type { Model, TranscriptBlock, TranscriptItem } from "../view-state"

export type ToolGroupKind = "explore" | "edit" | "shell" | "other"

export type ToolKind = "read" | "search" | "edit" | "shell" | "other"

export type AgentTerminal =
  | { readonly kind: "answer"; readonly entry: number }
  | { readonly kind: "error"; readonly text: string; readonly tone: "failed" | "cancelled" | "info" }

export type ToolTranscriptUnit = {
  readonly kind: "tool"
  readonly group: ToolGroupKind
  readonly blocks: ReadonlyArray<number>
  readonly diffs: ReadonlyArray<number>
  readonly children?: ReadonlyArray<ToolTranscriptUnit>
  readonly terminal?: AgentTerminal
}

export type TranscriptUnit =
  | { readonly kind: "entry"; readonly entry: number }
  | ToolTranscriptUnit
  | { readonly kind: "reasoning"; readonly block: number }
  | { readonly kind: "diff"; readonly block: number }
  | { readonly kind: "childAgent"; readonly block: number }
  | { readonly kind: "block"; readonly block: number }

export type TranscriptUnitId = string

const readToolNames = new Set(["read", "view_file"])
const searchToolNames = new Set(["grep", "find_files", "glob", "list_dir", "codebase_search"])
const editToolNames = new Set(["edit", "write"])
const shellToolNames = new Set(["bash", "run_command"])
const ToolInputJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))

export interface PathTarget {
  readonly path: string
  readonly line?: number
  readonly column?: number
}

export interface ToolDetail {
  readonly block: number
  readonly label: string
  readonly target?: PathTarget
}

export const escapePathTarget = (path: string): string =>
  [...path]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0
      return character === "\n"
        ? "\\n"
        : character === "\r"
          ? "\\r"
          : character === "\t"
            ? "\\t"
            : code < 0x20 || (code >= 0x7f && code <= 0x9f)
              ? `\\u{${code.toString(16)}}`
              : character
    })
    .join("")

const inputValue = (input: string): Record<string, unknown> =>
  Option.getOrElse(Schema.decodeUnknownOption(ToolInputJson)(input), () => ({}))

const stringValue = (value: Record<string, unknown>, keys: ReadonlyArray<string>): string | undefined => {
  for (const key of keys) if (typeof value[key] === "string" && value[key].length > 0) return value[key]
  return undefined
}

export const toolDetail: {
  (call: Extract<TranscriptBlock, { _tag: "ToolCall" }>): (block: number) => ToolDetail
  (block: number, call: Extract<TranscriptBlock, { _tag: "ToolCall" }>): ToolDetail
} = Function.dual(2, (block: number, call: Extract<TranscriptBlock, { _tag: "ToolCall" }>): ToolDetail => {
  const input = inputValue(call.input)
  const kind = toolKind(call.name, undefined)
  const path = call.files[0]?.path ?? stringValue(input, ["path", "file_path", "file"])
  const offset =
    typeof input.offset === "number" && Number.isFinite(input.offset)
      ? Math.max(0, Math.trunc(input.offset))
      : undefined
  const target =
    path === undefined
      ? undefined
      : {
          path,
          ...(offset === undefined ? {} : { line: offset + 1, column: 1 }),
        }
  const displayPath = path === undefined ? undefined : escapePathTarget(path)
  if (kind === "read") {
    const verb =
      call.presentation.action === "media" ? "Viewed" : call.presentation.action === "git-status" ? "Checked" : "Read"
    const location = path === undefined ? undefined : call.detail.match(/\s+L\d+(?:-\d+)?$/)?.[0]
    const detail = path === undefined ? call.detail : `${displayPath}${location ?? ""}`
    return {
      block,
      label: `${verb} ${detail || displayPath || call.name}`,
      ...(target === undefined ? {} : { target }),
    }
  }
  if (kind === "search") {
    const query = stringValue(input, ["pattern", "query", "glob", "path"])
    return {
      block,
      label: `${call.presentation.action === "grep" ? "Grep" : "Searched"} ${call.detail || query || "workspace"}`,
      ...(target === undefined ? {} : { target }),
    }
  }
  if (kind === "edit")
    return {
      block,
      label: `Edit ${displayPath ?? (call.detail || call.name)}`,
      ...(target === undefined ? {} : { target }),
    }
  if (kind === "shell") return { block, label: `$ ${call.detail || call.input}` }
  return {
    block,
    label: `${call.status === "running" ? call.presentation.activeLabel : call.presentation.completeLabel}${call.detail.length === 0 ? "" : ` ${call.detail}`}`,
  }
})

export const toolDetails: {
  (unit: Extract<TranscriptUnit, { kind: "tool" }>): (model: Model) => ReadonlyArray<ToolDetail>
  (model: Model, unit: Extract<TranscriptUnit, { kind: "tool" }>): ReadonlyArray<ToolDetail>
} = Function.dual(
  2,
  (model: Model, unit: Extract<TranscriptUnit, { kind: "tool" }>): ReadonlyArray<ToolDetail> =>
    unit.blocks.map((block) =>
      toolDetail(block, model.blocks[block] as Extract<TranscriptBlock, { _tag: "ToolCall" }>),
    ),
)

type ToolFamily = Extract<TranscriptBlock, { _tag: "ToolCall" }>["presentation"]["family"]

const toolKindImpl = (rawName: string, family: ToolFamily | undefined): ToolKind => {
  const name = rawName.toLowerCase()
  return family === "explore"
    ? readToolNames.has(name) || name === "view_media" || name === "git_status"
      ? "read"
      : "search"
    : family === "edit"
      ? "edit"
      : family === "shell"
        ? "shell"
        : readToolNames.has(name)
          ? "read"
          : searchToolNames.has(name)
            ? "search"
            : editToolNames.has(name)
              ? "edit"
              : shellToolNames.has(name)
                ? "shell"
                : "other"
}

export const toolKind: {
  (family: ToolFamily | undefined): (rawName: string) => ToolKind
  (rawName: string, family: ToolFamily | undefined): ToolKind
} = Function.dual(2, toolKindImpl)

const groupOf = (kind: ToolKind): ToolGroupKind => (kind === "read" || kind === "search" ? "explore" : kind)

const agentFailureFallback = "The subagent failed without a reported reason."
const agentEmptyFallback = "The subagent finished without a final message."
const agentCancelledFallback = "The subagent was cancelled."

export const agentOutputText = (output: string | undefined): string | undefined => {
  if (output === undefined) return undefined
  const value = output.trim()
  if (value.length === 0) return undefined
  if (!(value.startsWith("{") || value.startsWith("["))) return output
  try {
    const decoded: unknown = JSON.parse(value)
    if (
      typeof decoded === "object" &&
      decoded !== null &&
      "output" in decoded &&
      Array.isArray((decoded as { readonly output: unknown }).output)
    ) {
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
      if (text.trim().length > 0) return text
    }
    return typeof decoded === "object" && decoded !== null ? undefined : output
  } catch {
    return output
  }
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
  childErrorDetail(model, children) ?? outcomeReason(model, block) ?? agentOutputText(block.output) ?? fallback

export const agentTerminal = (
  model: Model,
  block: Extract<TranscriptBlock, { _tag: "ToolCall" }>,
  children: ReadonlyArray<TranscriptItem>,
): AgentTerminal | undefined => {
  const answer = lastAnswerEntry(model, children)
  return block.status === "running"
    ? undefined
    : block.status === "failed"
      ? { kind: "error", tone: "failed", text: settledText(model, block, children, agentFailureFallback) }
      : block.status === "complete"
        ? answer !== undefined
          ? { kind: "answer", entry: answer }
          : { kind: "error", tone: "info", text: settledText(model, block, children, agentEmptyFallback) }
        : answer !== undefined
          ? { kind: "answer", entry: answer }
          : { kind: "error", tone: "cancelled", text: settledText(model, block, children, agentCancelledFallback) }
}

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
  const built: RowsCache = { blocks: model.blocks, entries: model.entries, entryItemByIndex, blockItemByIndex }
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

const transcriptUnitsImpl = (model: Model): ReadonlyArray<TranscriptUnit> => {
  const units: Array<TranscriptUnit> = []
  const childItems = new Map<string, Array<TranscriptItem>>()
  for (const item of orderedTranscriptItems(model)) {
    if (item.parentId === undefined) continue
    childItems.set(item.parentId, [...(childItems.get(item.parentId) ?? []), item])
  }
  const agentTerminalFor = (block: Extract<TranscriptBlock, { _tag: "ToolCall" }>): AgentTerminal | undefined =>
    block.presentation.family === "agent" ? agentTerminal(model, block, childItems.get(block.id) ?? []) : undefined
  const nestedTools = (parentId: string): ReadonlyArray<ToolTranscriptUnit> =>
    (childItems.get(parentId) ?? []).flatMap((item) => {
      if (item._tag !== "Block") return []
      const block = model.blocks[item.index] as TranscriptBlock
      if (block._tag !== "ToolCall") return []
      const children = nestedTools(block.id)
      const terminal = agentTerminalFor(block)
      return [
        {
          kind: "tool" as const,
          group: groupOf(toolKind(block.name, block.presentation.family)),
          blocks: [item.index],
          diffs: [],
          ...(children.length === 0 ? {} : { children }),
          ...(terminal === undefined ? {} : { terminal }),
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
    if (block._tag === "ToolCall") {
      const children = nestedTools(block.id)
      const terminal = agentTerminalFor(block)
      if (children.length > 0 || terminal !== undefined) {
        flush()
        units.push({
          kind: "tool",
          group: groupOf(toolKind(block.name, block.presentation.family)),
          blocks: [item.index],
          diffs: [],
          ...(children.length === 0 ? {} : { children }),
          ...(terminal === undefined ? {} : { terminal }),
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

export const isExpandableUnit = (unit: TranscriptUnit): boolean =>
  unit.kind === "tool" || unit.kind === "reasoning" || unit.kind === "diff" || unit.kind === "childAgent"

export const expandableUnits = (model: Model): ReadonlyArray<TranscriptUnit> =>
  transcriptUnits(model).filter(isExpandableUnit)

export const expandableRowIds = (model: Model): ReadonlyArray<TranscriptUnitId> => {
  const ids: Array<TranscriptUnitId> = []
  const expanded = new Set(model.expandedRowKeys)
  const appendTool = (unit: ToolTranscriptUnit) => {
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
        if (block.output !== undefined && block.output.length > 0) ids.push(`tool-child:${block.id}`)
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

export const unitToggleTargets = (unit: TranscriptUnit): ReadonlyArray<number> =>
  unit.kind === "tool" ? unit.blocks : unit.kind === "reasoning" || unit.kind === "diff" ? [unit.block] : []
