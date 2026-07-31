import { TextRenderable, StyledText } from "@opentui/core"
import { Function, Option, Schema } from "effect"
import stringWidth from "string-width"
import type { Model, TranscriptBlock, TranscriptItem } from "../../state/model/terminal-state"
import type { TextChunk } from "@opentui/core"
import {
  maxMountedTranscriptRows,
  toolKind,
  type AgentOutcome,
  type AgentResponseState,
  type PathTarget,
  type ToolKind,
  type ToolTranscriptUnit,
  type TranscriptUnit,
} from "../../presentation/transcript/terminal-transcript-presentation"
import { spacing } from "../../presentation/terminal/terminal-theme"
import { idleSpinnerFrame } from "./opentui-spinner"

export const transcriptWrapWidth = (width: number): number => Math.max(8, width - spacing.transcript * 2 - 2)
const ToolInputJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))

const toolInputValue = (input: string): Record<string, unknown> =>
  Option.getOrElse(Schema.decodeUnknownOption(ToolInputJson)(input), () => ({}))

const inputString = (value: Record<string, unknown>, keys: ReadonlyArray<string>): string | undefined => {
  for (const key of keys) {
    const candidate = value[key]
    if (typeof candidate === "string" && candidate.length > 0) return candidate
  }
  return undefined
}

export type ToolUnit = {
  readonly kind: ToolKind
  readonly block: Extract<TranscriptBlock, { _tag: "ToolCall" }>
  readonly index: number
}

const diffCounts = (patch: string): readonly [number, number] => {
  let added = 0
  let removed = 0
  for (const line of patch.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added += 1
    else if (line.startsWith("-") && !line.startsWith("---")) removed += 1
  }
  return [added, removed]
}

const shellCommandText = (block: Extract<TranscriptBlock, { _tag: "ToolCall" }>): string => {
  const value = toolInputValue(block.input)
  const command = block.detail || inputString(value, ["command", "cmd", "script"]) || ""
  return command || (block.input.trimStart().startsWith("{") ? "" : block.input)
}

const shellExitCode = (block: Extract<TranscriptBlock, { _tag: "ToolCall" }>): number | undefined =>
  block.process?.exitCode

const exploreChildLabel = (unit: ToolUnit): string => {
  const value = toolInputValue(unit.block.input)
  const detail =
    unit.block.detail ||
    inputString(value, ["path", "file_path", "file", "pattern", "query", "glob", "name"]) ||
    "workspace"
  if (unit.block.presentation.action === "skill") return detail
  if (unit.block.presentation.action === "media") return `Viewed ${detail}`
  if (unit.block.presentation.action === "git-status") return `Checked ${detail}`
  if (unit.block.presentation.action === "read" || unit.kind === "read") return `Read ${detail}`
  const pattern = inputString(value, ["pattern", "query", "glob", "path"])
  return `${unit.block.presentation.action === "grep" ? "Grep" : "Searched"} ${unit.block.detail || pattern || ""}`.trimEnd()
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })
export const wrapTextToWidth = (text: string, width: number): ReadonlyArray<string> => {
  const lines: Array<string> = []
  for (const hardLine of text.split("\n")) {
    let rest = hardLine
    while (stringWidth(rest) > width) {
      let end = 0
      let breakAt = 0
      let used = 0
      for (const { segment, index } of graphemeSegmenter.segment(rest)) {
        const cells = stringWidth(segment)
        if (used + cells > width) break
        used += cells
        end = index + segment.length
        if (/\s/u.test(segment)) breakAt = end
      }
      let split = breakAt === 0 ? end : breakAt
      if (split === 0) split = rest.slice(0, 1).length
      lines.push(rest.slice(0, split).trimEnd())
      rest = rest.slice(split).trimStart()
    }
    lines.push(rest)
  }
  return lines
}
export const wrapBodyText = (text: string, width: number, indent: string): string =>
  wrapTextToWidth(text, Math.max(1, width - stringWidth(indent)))
    .map((line) => `${indent}${line}`)
    .join("\n")
export const iconChar = (failed: boolean, running: boolean, frame = idleSpinnerFrame, cancelled = false): string => {
  if (running) return frame
  if (cancelled) return "⊘"
  return failed ? "✕" : "✓"
}

export const markerText = (expanded: boolean): string => (expanded ? " ▾" : " ▸")

export const cancelledAgentLabel = (activeLabel: string): string =>
  `${activeLabel.split(" ")[0] ?? "Subagent"} cancelled`
export const failedAgentLabel = (activeLabel: string): string => `${activeLabel.split(" ")[0] ?? "Subagent"} failed`

export interface UnitLineRange {
  readonly start: number
  readonly end: number
  readonly headerEnd?: number
  readonly unit: string
  readonly expandable: boolean
  readonly animated?: boolean
  readonly gapBefore?: boolean
  readonly targets?: ReadonlyArray<PathTarget>
}

export const maxMountedTranscriptEntries = 600

export const maxBoundedTranscriptItems = 1200

export { maxMountedTranscriptRows } from "../../presentation/transcript/terminal-transcript-presentation"

type BoundedTranscriptModel = Omit<Model, "items"> & { readonly items: ReadonlyArray<TranscriptItem> }

export const boundedTranscriptModel: {
  (model: Model): BoundedTranscriptModel
  (model: Model, end: number): BoundedTranscriptModel
  (end: number): (model: Model) => BoundedTranscriptModel
} = Function.dual(
  (args) => typeof args[0] === "object",
  (model: Model, end = model.items.length): BoundedTranscriptModel => {
    const limit = maxMountedTranscriptEntries
    if (model.items.length === 0)
      return {
        ...model,
        entries: model.entries.slice(-limit),
        blocks: model.blocks.slice(-limit),
        items: [],
      }
    const windowEnd = Math.min(model.items.length, Math.max(0, Math.floor(end)))
    if (windowEnd === model.items.length && model.items.length <= limit)
      return { ...model, items: model.items as ReadonlyArray<TranscriptItem> }
    const allItems = model.items as ReadonlyArray<TranscriptItem>
    let hasParent = false
    for (let position = 0; position < windowEnd; position += 1)
      if (allItems[position]?.parentId !== undefined) {
        hasParent = true
        break
      }
    if (!hasParent) {
      const flat = allItems.slice(Math.max(0, windowEnd - limit), windowEnd)
      const entries: Array<Model["entries"][number]> = []
      const blocks: Array<Model["blocks"][number]> = []
      const entryIndices = new Map<number, number>()
      const blockIndices = new Map<number, number>()
      const items: Array<TranscriptItem> = []
      for (const item of flat) {
        if (item._tag === "Entry") {
          let index = entryIndices.get(item.index)
          if (index === undefined) {
            index = entries.length
            entryIndices.set(item.index, index)
            entries.push(model.entries[item.index]!)
          }
          items.push({ ...item, index })
          continue
        }
        let index = blockIndices.get(item.index)
        if (index === undefined) {
          index = blocks.length
          blockIndices.set(item.index, index)
          blocks.push(model.blocks[item.index]!)
        }
        items.push({ ...item, index })
      }
      return { ...model, entries, blocks, items }
    }
    const itemPositionByBlockId = new Map<string, number>()
    for (const [position, item] of allItems.entries()) {
      if (item._tag !== "Block") continue
      const block = model.blocks[item.index] as TranscriptBlock | undefined
      if (block?._tag === "ToolCall") itemPositionByBlockId.set(block.id, position)
    }
    const rootPositionOf = (start: number): number => {
      let position = start
      const seen = new Set<number>()
      while (!seen.has(position)) {
        seen.add(position)
        const parentId = allItems[position]?.parentId
        if (parentId === undefined) return position
        const parentPosition = itemPositionByBlockId.get(parentId)
        if (parentPosition === undefined) return position
        position = parentPosition
      }
      return position
    }
    const unitMembers = new Map<number, Array<number>>()
    const unitRoots: Array<number> = []
    for (let position = 0; position < windowEnd; position += 1) {
      const root = rootPositionOf(position)
      let members = unitMembers.get(root)
      if (members === undefined) {
        members = []
        unitMembers.set(root, members)
        unitRoots.push(root)
      }
      members.push(position)
    }
    const expandedRows = new Set(model.expandedRowKeys)
    const visibleByPosition = new Map<number, boolean>()
    const isVisiblePosition = (position: number): boolean => {
      const cached = visibleByPosition.get(position)
      if (cached !== undefined) return cached
      let visible = true
      const seen = new Set<number>()
      let current = position
      while (!seen.has(current)) {
        seen.add(current)
        const parentId = allItems[current]?.parentId
        if (parentId === undefined) break
        if (!expandedRows.has(`tool:${parentId}`)) {
          visible = false
          break
        }
        const parent = itemPositionByBlockId.get(parentId)
        if (parent === undefined) break
        current = parent
      }
      visibleByPosition.set(position, visible)
      return visible
    }
    const orderedRoots = unitRoots.toSorted((left, right) => left - right)
    const selectedPositions = new Set<number>()
    let visibleSelected = 0
    for (let unitIndex = orderedRoots.length - 1; unitIndex >= 0; unitIndex -= 1) {
      const members = unitMembers.get(orderedRoots[unitIndex]!)!
      const remainingVisible = limit - visibleSelected
      const remainingMounted = maxBoundedTranscriptItems - selectedPositions.size
      if (remainingVisible <= 0 || remainingMounted <= 0) break
      const visibleMembers = members.reduce((count, position) => count + (isVisiblePosition(position) ? 1 : 0), 0)
      if (visibleMembers <= remainingVisible && members.length <= remainingMounted) {
        for (const position of members) selectedPositions.add(position)
        visibleSelected += visibleMembers
        continue
      }
      const required = new Set<number>()
      let requiredVisible = 0
      const ancestorsOf = (position: number): ReadonlyArray<number> => {
        const ancestors: Array<number> = []
        const seen = new Set<number>()
        let current = position
        while (!seen.has(current)) {
          seen.add(current)
          const parentId = allItems[current]?.parentId
          if (parentId === undefined) break
          const parent = itemPositionByBlockId.get(parentId)
          if (parent === undefined) break
          ancestors.unshift(parent)
          current = parent
        }
        return ancestors
      }
      for (let position = members.length - 1; position >= 0; position -= 1) {
        const member = members[position]!
        const additions = [...ancestorsOf(member), member].filter((candidate) => !required.has(candidate))
        if (required.size + additions.length > remainingMounted) break
        const additionsVisible = additions.reduce(
          (count, candidate) => count + (isVisiblePosition(candidate) ? 1 : 0),
          0,
        )
        if (requiredVisible + additionsVisible > remainingVisible) break
        for (const addition of additions) required.add(addition)
        requiredVisible += additionsVisible
      }
      for (const position of required) selectedPositions.add(position)
      visibleSelected += requiredVisible
      if (requiredVisible < visibleMembers) break
    }
    const source = [...selectedPositions].toSorted((left, right) => left - right).map((position) => allItems[position]!)
    const entries: Array<Model["entries"][number]> = []
    const blocks: Array<Model["blocks"][number]> = []
    const entryIndices = new Map<number, number>()
    const blockIndices = new Map<number, number>()
    const items: Array<TranscriptItem> = []
    for (const item of source) {
      if (item._tag === "Entry") {
        let index = entryIndices.get(item.index)
        if (index === undefined) {
          index = entries.length
          entryIndices.set(item.index, index)
          entries.push(model.entries[item.index]!)
        }
        items.push({ ...item, index })
        continue
      }
      let index = blockIndices.get(item.index)
      if (index === undefined) {
        index = blocks.length
        blockIndices.set(item.index, index)
        blocks.push(model.blocks[item.index]!)
      }
      items.push({ ...item, index })
    }
    return { ...model, entries, blocks, items }
  },
)

export const toolUnitsFor = (model: Model, indices: ReadonlyArray<number>): ReadonlyArray<ToolUnit> =>
  indices.map((index) => {
    const block = model.blocks[index] as Extract<TranscriptBlock, { _tag: "ToolCall" }>
    return { kind: toolKind(block.name, undefined), block, index }
  })

export interface TranscriptUnitBuild {
  readonly chunks: ReadonlyArray<TextChunk>
  readonly lines: number
  readonly root: UnitLineRange
  readonly nested: ReadonlyArray<UnitLineRange>
}

export const offsetUnitRange = (range: UnitLineRange, offset: number): UnitLineRange => ({
  ...range,
  start: range.start + offset,
  end: range.end + offset,
  ...(range.headerEnd === undefined ? {} : { headerEnd: range.headerEnd + offset }),
})

let transcriptIdentityCounter = 0
const transcriptIdentityRevisions = new WeakMap<object, number>()
const identityRevision = (value: unknown): number => {
  if (typeof value !== "object" || value === null) return 0
  const current = transcriptIdentityRevisions.get(value)
  if (current !== undefined) return current
  transcriptIdentityCounter += 1
  transcriptIdentityRevisions.set(value, transcriptIdentityCounter)
  return transcriptIdentityCounter
}

export const agentResponseOutcome = (state: AgentResponseState): AgentOutcome =>
  state._tag === "Streaming" ? { kind: "answer", entry: state.answer } : state.outcome

export const transcriptUnitRevision = (
  model: Model,
  unit: TranscriptUnit,
  unitKey: string,
  expandedSet: ReadonlySet<string>,
): string => {
  const ids: Array<number> = []
  const bits: Array<string> = []
  const pushExpanded = (id: string) => bits.push(expandedSet.has(id) ? "1" : "0")
  const walkTool = (tool: ToolTranscriptUnit) => {
    for (const index of tool.blocks) {
      const block = model.blocks[index] as TranscriptBlock
      ids.push(identityRevision(block))
      if (block._tag === "ToolCall") {
        pushExpanded(`tool:${block.id}`)
        pushExpanded(`tool-child:${block.id}`)
        for (const file of block.files) pushExpanded(`file:${file.key}`)
      }
    }
    for (const index of tool.diffs) ids.push(identityRevision(model.blocks[index]))
    for (const child of tool.children ?? []) walkTool(child)
    const response = tool.agentResponse === undefined ? undefined : agentResponseOutcome(tool.agentResponse)
    if (response?.kind === "answer") ids.push(identityRevision(model.entries[response.entry]))
    else if (response?.kind === "error") bits.push(`${response.tone}:${response.text}`)
  }
  if (unit.kind === "entry") ids.push(identityRevision(model.entries[unit.entry]))
  else if (unit.kind === "tool") walkTool(unit)
  else ids.push(identityRevision(model.blocks[unit.block]))
  pushExpanded(unitKey)
  const selected = model.detailSelection === unitKey ? "1" : "0"
  return `${ids.join(".")}|${bits.join("")}|${selected}|${model.width}`
}

export interface TranscriptRenderableDescriptor {
  readonly key: string
  readonly revision: string
  readonly content: StyledText
  readonly selectable?: boolean
  readonly spinnerChunk?: number
  readonly targets?: ReadonlyArray<PathTarget>
  readonly onMouseDown?: TextRenderable["onMouseDown"]
}
export interface TranscriptRangeBundle {
  readonly key: string
  readonly descriptors: ReadonlyArray<TranscriptRenderableDescriptor>
}

export interface TranscriptUnitCacheEntry {
  readonly revision: string
  readonly bundles: ReadonlyArray<TranscriptRangeBundle>
}

export { exploreChildLabel, inputString, toolInputValue, diffCounts, shellCommandText, shellExitCode }
