import { Function } from "effect"
import type { Model, TranscriptBlock, TranscriptItem } from "./view-state"

export type ToolGroupKind = "explore" | "edit" | "shell" | "other"

export type ToolKind = "read" | "search" | "edit" | "shell" | "other"

export type TranscriptUnit =
  | { readonly kind: "entry"; readonly entry: number }
  | {
      readonly kind: "tool"
      readonly group: ToolGroupKind
      readonly blocks: ReadonlyArray<number>
      readonly diffs: ReadonlyArray<number>
    }
  | { readonly kind: "reasoning"; readonly block: number }
  | { readonly kind: "diff"; readonly block: number }
  | { readonly kind: "childAgent"; readonly block: number }
  | { readonly kind: "block"; readonly block: number }

export type TranscriptUnitId = string

const readToolNames = new Set(["read_file", "read", "view_file"])
const searchToolNames = new Set(["grep", "find_files", "glob", "list_dir", "codebase_search"])
const editToolNames = new Set(["edit_file", "create_file", "apply_patch", "write_file"])
const shellToolNames = new Set(["shell", "shell_command_status", "bash", "run_command"])

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

const inputValue = (input: string): Record<string, unknown> => {
  try {
    const value = JSON.parse(input)
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

const stringValue = (value: Record<string, unknown>, keys: ReadonlyArray<string>): string | undefined => {
  for (const key of keys) if (typeof value[key] === "string" && value[key].length > 0) return value[key]
  return undefined
}

export const toolDetail: {
  (call: Extract<TranscriptBlock, { _tag: "ToolCall" }>): (block: number) => ToolDetail
  (block: number, call: Extract<TranscriptBlock, { _tag: "ToolCall" }>): ToolDetail
} = Function.dual(2, (block: number, call: Extract<TranscriptBlock, { _tag: "ToolCall" }>): ToolDetail => {
  const input = inputValue(call.input)
  const kind = toolKind(call.name)
  const path = stringValue(input, ["path", "file_path", "file"])
  const target =
    path === undefined
      ? undefined
      : {
          path,
          ...(typeof input.offset === "number" ? { line: input.offset } : {}),
        }
  if (kind === "read") return { block, label: `Read ${path ?? call.name}`, ...(target === undefined ? {} : { target }) }
  if (kind === "search") {
    const query = stringValue(input, ["pattern", "query", "glob", "path"])
    return {
      block,
      label: `${call.name === "grep" ? "Grep" : "Searched"} ${query ?? "workspace"}`,
      ...(target === undefined ? {} : { target }),
    }
  }
  if (kind === "edit") return { block, label: `Edit ${path ?? call.name}`, ...(target === undefined ? {} : { target }) }
  if (kind === "shell") return { block, label: `$ ${stringValue(input, ["command", "cmd", "script"]) ?? call.input}` }
  return { block, label: call.name }
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

export const toolKind = (rawName: string): ToolKind => {
  const name = rawName.toLowerCase()
  return readToolNames.has(name)
    ? "read"
    : searchToolNames.has(name)
      ? "search"
      : editToolNames.has(name)
        ? "edit"
        : shellToolNames.has(name)
          ? "shell"
          : "other"
}

const groupOf = (kind: ToolKind): ToolGroupKind => (kind === "read" || kind === "search" ? "explore" : kind)

export const orderedTranscriptItems = (model: Model): ReadonlyArray<TranscriptItem> =>
  model.items.length > 0
    ? (model.items as ReadonlyArray<TranscriptItem>)
    : [
        ...model.entries.map((_, index) => ({ _tag: "Entry" as const, index })),
        ...model.blocks.map((_, index) => ({ _tag: "Block" as const, index })),
      ]

export const transcriptUnits = (model: Model): ReadonlyArray<TranscriptUnit> => {
  const units: Array<TranscriptUnit> = []
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
    if (item._tag === "Entry") {
      flush()
      units.push({ kind: "entry", entry: item.index })
      continue
    }
    const block = model.blocks[item.index] as TranscriptBlock
    if (block._tag === "ToolCall") {
      toolRun.push({ index: item.index, kind: toolKind(block.name) })
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
  unit.kind === "tool" || unit.kind === "reasoning" || unit.kind === "diff"

export const expandableUnits = (model: Model): ReadonlyArray<TranscriptUnit> =>
  transcriptUnits(model).filter(isExpandableUnit)

export const transcriptUnitId: {
  (model: Model, unit: TranscriptUnit): TranscriptUnitId
  (unit: TranscriptUnit): (model: Model) => TranscriptUnitId
} = Function.dual(2, (model: Model, unit: TranscriptUnit): TranscriptUnitId => {
  if (unit.kind === "entry") return `entry:${unit.entry}`
  if (unit.kind === "tool") {
    const ids = unit.blocks.map((index) => {
      const block = model.blocks[index] as Extract<TranscriptBlock, { _tag: "ToolCall" }>
      return block.id
    })
    return `tool:${ids.join("+")}`
  }
  const block = model.blocks[unit.block] as TranscriptBlock
  if ("id" in block && typeof block.id === "string") return `block:${block.id}`
  return `block:${block._tag}:${unit.block}`
})

export const unitToggleTargets = (unit: TranscriptUnit): ReadonlyArray<number> =>
  unit.kind === "tool" ? unit.blocks : unit.kind === "reasoning" || unit.kind === "diff" ? [unit.block] : []
