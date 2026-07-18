import { Function, Option, Schema } from "effect"
import type { Model, TranscriptBlock, TranscriptItem } from "./view-state"

export type ToolGroupKind = "explore" | "edit" | "shell" | "other"

export type ToolKind = "read" | "search" | "edit" | "shell" | "other"

export type ToolTranscriptUnit = {
  readonly kind: "tool"
  readonly group: ToolGroupKind
  readonly blocks: ReadonlyArray<number>
  readonly diffs: ReadonlyArray<number>
  readonly children?: ReadonlyArray<ToolTranscriptUnit>
  readonly response?: number
}

export type TranscriptUnit =
  | { readonly kind: "entry"; readonly entry: number }
  | ToolTranscriptUnit
  | { readonly kind: "reasoning"; readonly block: number }
  | { readonly kind: "diff"; readonly block: number }
  | { readonly kind: "childAgent"; readonly block: number }
  | { readonly kind: "block"; readonly block: number }

export type TranscriptUnitId = string

const readToolNames = new Set(["read_file", "read", "view_file"])
const searchToolNames = new Set(["grep", "find_files", "glob", "list_dir", "codebase_search"])
const editToolNames = new Set(["edit_file", "create_file", "apply_patch", "write_file"])
const shellToolNames = new Set(["shell", "bash", "run_command"])
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

export const orderedTranscriptItems = (model: Model): ReadonlyArray<TranscriptItem> =>
  model.items.length > 0
    ? (model.items as ReadonlyArray<TranscriptItem>)
    : [
        ...model.entries.map((_, index) => ({ _tag: "Entry" as const, index })),
        ...model.blocks.map((_, index) => ({ _tag: "Block" as const, index })),
      ]

export const transcriptUnits = (model: Model): ReadonlyArray<TranscriptUnit> => {
  const units: Array<TranscriptUnit> = []
  const childItems = new Map<string, Array<TranscriptItem>>()
  for (const item of orderedTranscriptItems(model)) {
    if (item.parentId === undefined) continue
    childItems.set(item.parentId, [...(childItems.get(item.parentId) ?? []), item])
  }
  const childResponse = (parentId: string): number | undefined =>
    childItems
      .get(parentId)
      ?.findLast(
        (item): item is Extract<TranscriptItem, { readonly _tag: "Entry" }> =>
          item._tag === "Entry" && model.entries[item.index]?.role === "assistant",
      )?.index
  const nestedTools = (parentId: string): ReadonlyArray<ToolTranscriptUnit> =>
    (childItems.get(parentId) ?? []).flatMap((item) => {
      if (item._tag !== "Block") return []
      const block = model.blocks[item.index] as TranscriptBlock
      if (block._tag !== "ToolCall") return []
      const children = nestedTools(block.id)
      const response = childResponse(block.id)
      return [
        {
          kind: "tool" as const,
          group: groupOf(toolKind(block.name, block.presentation.family)),
          blocks: [item.index],
          diffs: [],
          ...(children.length === 0 ? {} : { children }),
          ...(response === undefined ? {} : { response }),
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
      const response = childResponse(block.id)
      if (children.length > 0 || response !== undefined) {
        flush()
        units.push({
          kind: "tool",
          group: groupOf(toolKind(block.name, block.presentation.family)),
          blocks: [item.index],
          diffs: [],
          ...(children.length === 0 ? {} : { children }),
          ...(response === undefined ? {} : { response }),
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
  const appendTool = (unit: ToolTranscriptUnit) => {
    const id = transcriptUnitId(model, unit)
    ids.push(id)
    if (!model.expandedRowKeys.includes(id)) return
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
  if (unit.kind === "entry") {
    const entry = model.entries[unit.entry]
    const item = orderedTranscriptItems(model).find(
      (candidate) => candidate._tag === "Entry" && candidate.index === unit.entry,
    )
    return `entry:${item?.id ?? `${entry?.turnId ?? "legacy"}:${entry?.role ?? "entry"}:${unit.entry}`}`
  }
  if (unit.kind === "tool") {
    const block = model.blocks[unit.blocks[0]!] as Extract<TranscriptBlock, { _tag: "ToolCall" }>
    return `tool:${block.id}`
  }
  const block = model.blocks[unit.block] as TranscriptBlock
  const item = orderedTranscriptItems(model).find(
    (candidate) => candidate._tag === "Block" && candidate.index === unit.block,
  )
  if (item?.id !== undefined) return `block:${item.id}`
  if ("id" in block && typeof block.id === "string") return `block:${block.id}`
  return `block:${block._tag}:${unit.block}`
})

export const unitToggleTargets = (unit: TranscriptUnit): ReadonlyArray<number> =>
  unit.kind === "tool" ? unit.blocks : unit.kind === "reasoning" || unit.kind === "diff" ? [unit.block] : []
