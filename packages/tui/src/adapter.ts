import {
  BoxRenderable,
  EditBufferRenderable,
  ScrollBarRenderable,
  ScrollBoxRenderable,
  type CliRenderer,
  CliRenderEvents,
  TextRenderable,
  createCliRenderer,
  decodePasteBytes,
  stripAnsiSequences,
  bg,
  bold,
  dim,
  fg,
  italic,
  strikethrough,
  underline,
  RGBA,
  SystemClock,
  StyledText,
  type Clock as OpenTuiClock,
  type TextChunk,
  type TimerHandle,
} from "@opentui/core"
import type { ColorInput, KeyEvent, MouseEvent, PasteEvent } from "@opentui/core"
import cliSpinners from "cli-spinners"
import * as Transcript from "@rika/transcript"
import { Clock, Effect, Fiber, Function, Option, Schedule, Schema } from "effect"
import stringWidth from "string-width"
import { cursorBlink } from "./cursor-blink"
import { fromOpenTui, type Key } from "./keys"
import {
  composerHeight,
  contentColumnWidth,
  boundedThreadSidebarWidth,
  displayInput,
  fileSidebarLayoutWidth,
  filteredFiles,
  filteredThreads,
  formatActivity,
  initial,
  isLoading,
  isNarrow,
  isReady,
  pastedTextTokenAt,
  queueContentWidth,
  readyOr,
  selectedThreadMetadata,
  threadSidebarLayoutWidth,
  wrappedRowCount,
  type Mode,
  type Model,
  type QueueItem,
  type TranscriptItem,
} from "./view-state"
import type { ThreadItem, TranscriptBlock } from "./view-state"
import { projectUnits, type Event } from "./execution-events"
import { filter, type Command } from "./palette"
import { colors, spacing } from "./theme"
import { renderMarkdown, renderMarkdownLines, renderMarkdownStyled } from "./markdown-renderer"
import { renderDiff, renderDiffStyled, renderPartialDiffStyled } from "./diff-renderer"
import { renderPierreDiff } from "./pierre-diff"
import { renderTool } from "./tool-renderer"
import {
  escapePathTarget,
  isExpandableUnit,
  orderedTranscriptItems,
  toolDetail,
  toolKind,
  transcriptUnitId,
  transcriptUnits,
  toolDetails,
  type PathTarget,
  type ToolKind,
  type ToolTranscriptUnit,
} from "./transcript-units"

export const spinnerFrames: ReadonlyArray<string> = cliSpinners.dots.frames
export const statusSpinnerFrames: ReadonlyArray<string> = ["∼", "≈", "≋", "≈", "∼"]
export const spinnerInterval = 200
export const idleSpinnerFrame = "⠭"

export class ToolSpinner {
  private state = [true, false, true, false, true, false, true, false]
  private previousState: ReadonlyArray<boolean> = []
  private generation = 0
  private readonly neighborMap = [
    [1, 3, 4, 5, 7],
    [0, 2, 4, 5, 6],
    [1, 3, 5, 6, 7],
    [0, 2, 4, 6, 7],
    [0, 1, 3, 5, 7],
    [0, 1, 2, 4, 6],
    [1, 2, 3, 5, 7],
    [0, 2, 3, 4, 6],
  ]

  constructor(private readonly random: () => number = Math.random) {}

  step(): void {
    const next = this.state.map((alive, index) => {
      const neighbors = this.neighborMap[index]!.filter((neighbor) => this.state[neighbor]).length
      return alive ? neighbors === 2 || neighbors === 3 : neighbors === 3 || neighbors === 6
    })
    const stable = next.every((alive, index) => alive === this.state[index])
    const repeats = this.previousState.length > 0 && next.every((alive, index) => alive === this.previousState[index])
    this.previousState = [...this.state]
    this.state = next
    this.generation += 1
    const live = next.filter(Boolean).length
    if (stable || repeats || this.generation >= 15 || live < 2) {
      let seeded: Array<boolean>
      do seeded = Array.from({ length: 8 }, () => this.random() > 0.6)
      while (seeded.filter(Boolean).length < 3)
      this.state = seeded
      this.previousState = []
      this.generation = 0
    }
  }

  toBraille(): string {
    const dots = [0, 1, 2, 6, 3, 4, 5, 7]
    let point = 0x2800
    for (const [index, alive] of this.state.entries()) if (alive) point |= 1 << dots[index]!
    return String.fromCharCode(point)
  }
}

const markdownWidthForColumn = (width: number): number => Math.max(8, width - spacing.transcript * 2 - 2)

const queueItemLabel = (item: QueueItem): string =>
  `${item.prompt}${item.attachments?.map((path) => `\n  ▧ ${path}`).join("") ?? ""}`

interface QueueHintSegment {
  readonly accent: string
  readonly suffix: string
}

const queueNavigationHint: ReadonlyArray<QueueHintSegment> = [
  { accent: "Enter", suffix: " to steer" },
  { accent: "Backspace", suffix: " to dequeue" },
  { accent: "Ctrl+E", suffix: " to edit" },
]

const queueEditingHint: ReadonlyArray<QueueHintSegment> = [
  { accent: "Editing queued", suffix: "" },
  { accent: "Enter", suffix: " save" },
  { accent: "Esc", suffix: " cancel" },
]

const minimumInlineQueueMessageWidth = 12

const queueHintWidth = (segments: ReadonlyArray<QueueHintSegment>): number =>
  stringWidth(` ${segments.map((segment) => `${segment.accent}${segment.suffix}`).join(" · ")} `)

const fittingQueueHint = (
  segments: ReadonlyArray<QueueHintSegment>,
  width: number,
): ReadonlyArray<QueueHintSegment> => {
  for (let length = segments.length; length > 0; length -= 1) {
    const candidate = segments.slice(0, length)
    if (width - queueHintWidth(candidate) >= minimumInlineQueueMessageWidth) return candidate
  }
  return []
}

export class AdapterError extends Schema.TaggedErrorClass<AdapterError>()("TuiAdapterError", {
  message: Schema.String,
}) {}

const adapterError = (cause: unknown) => AdapterError.make({ message: String(cause) })

export const loaderFrame: {
  (phase: string | undefined, frame: number): string
  (frame: number): (phase: string | undefined) => string
} = Function.dual(2, (phase: string | undefined, frame: number): string =>
  phase === undefined ? "" : statusSpinnerFrames[frame % statusSpinnerFrames.length]!,
)

export const renderBlock: {
  (width?: number): (block: TranscriptBlock) => string
  (block: TranscriptBlock): string
  (block: TranscriptBlock, width?: number): string
} = Function.dual(
  (args) => args.length > 1 || typeof args[0] !== "number",
  (block: TranscriptBlock, width = 80): string => {
    switch (block._tag) {
      case "Reasoning":
        return `◇ Reasoning\n  ${block.text}`
      case "ToolCall": {
        return renderTool(block, width)
      }
      case "ToolResult":
        return `${block.failed ? "✕" : "✓"} Result\n  ${block.output}`
      case "Diff":
        return `Δ ${block.path}\n${renderDiff(block.patch, width)}`
      case "ContextUsage":
        return `◷ Context ${block.text}${block.cost === undefined ? "" : ` · ${block.cost}`}`
      case "Compaction":
        return `↻ Compacted context${block.checkpoint === undefined ? "" : ` at ${block.checkpoint}`}\n  ${block.summary}`
      case "Notification":
        return `! ${block.title}\n  ${block.detail}`
      case "Error":
        return `✖ ERROR: ${block.title}${block.turnId === undefined ? "" : ` · Turn ${block.turnId}`}\n  ${block.detail}${block.recovery === undefined ? "" : `\n  Next: ${block.recovery}`}`
      case "Permission":
        return `? ${block.title} [${block.status}]\n  ${block.detail}`
      case "ChildAgent": {
        const icon =
          block.status === "running"
            ? "⠿"
            : block.status === "complete"
              ? "✓"
              : block.status === "cancelled"
                ? "⊘"
                : "✗"
        return `${icon} Subagent ${block.status === "running" ? "working" : block.status === "cancelled" ? "cancelled" : "finished"} ▸\n  ${block.name} · ${block.summary}`
      }
      case "Workflow":
        return `◫ Workflow ${block.name} [${block.status}]\n  ${block.step}`
      case "ImageAttachment": {
        const dimensions =
          block.width !== undefined && block.height !== undefined ? ` · ${block.width}×${block.height}` : ""
        const size = block.bytes === undefined ? "" : ` · ${block.bytes} bytes`
        return `▧ ${block.name} · ${block.mediaType}${dimensions}${size}`
      }
    }
  },
)

export const renderSidebar: {
  (spinnerFrame?: string): (model: Model) => StyledText
  (model: Model): StyledText
  (model: Model, spinnerFrame?: string): StyledText
} = Function.dual(
  (args) => args.length > 1 || typeof args[0] !== "string",
  (model: Model, spinnerFrame = idleSpinnerFrame): StyledText => {
    const chunks: Array<TextChunk> = []
    const threads = model.threads as ReadonlyArray<ThreadItem>
    const sidebarWidth = boundedThreadSidebarWidth(model.width)
    threads
      .slice(model.threadSidebar.scrollTop, model.threadSidebar.scrollTop + model.height)
      .forEach((thread, row) => {
        const index = row + model.threadSidebar.scrollTop
        if (row > 0) chunks.push(fg(colors.text)("\n"))
        const selected = model.threadSidebar.focused && index === model.threadSidebar.selected
        const marker =
          thread.id === model.currentThreadId
            ? "*"
            : thread.status !== "idle"
              ? spinnerFrame
              : thread.unread
                ? "○"
                : " "
        const title = truncateToWidth(thread.title, sidebarWidth - 4)
        const padding = " ".repeat(Math.max(0, sidebarWidth - 4 - stringWidth(title)))
        const renderedRow = ` ${marker} ${title}${padding}`
        if (selected) chunks.push(bg(colors.amber)(fg(colors.surface)(renderedRow)))
        else {
          chunks.push(fg(colors.text)(" "))
          chunks.push(
            thread.id === model.currentThreadId
              ? fg(colors.green)(marker)
              : thread.status !== "idle"
                ? fg(colors.blue)(marker)
                : thread.unread
                  ? dim(fg(colors.blue)(marker))
                  : fg(colors.text)(marker),
          )
          chunks.push(fg(colors.text)(` ${title}${padding}`))
        }
        chunks.push(dim(fg(colors.text)("│")))
      })
    return new StyledText(chunks)
  },
)

const changedFileColor = (status: string): ColorInput => {
  if (status.includes("?")) return colors.muted
  if (status.includes("A")) return colors.green
  if (status.includes("D")) return colors.red
  if (status.includes("R")) return colors.purple
  if (status.includes("M")) return colors.amber
  return colors.text
}

interface ChangedNode {
  readonly children: Map<string, ChangedNode>
  file?: import("./view-state").ChangedFile
}

interface ChangedFileRow {
  readonly chunks: ReadonlyArray<TextChunk>
  readonly file?: import("./view-state").ChangedFile
  readonly nameIndex?: number
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })

const truncateToWidth = (text: string, width: number): string => {
  let truncated = ""
  let used = 0
  for (const { segment } of graphemeSegmenter.segment(text)) {
    const cells = stringWidth(segment)
    if (used + cells > width) break
    truncated += segment
    used += cells
  }
  return truncated
}

const escapeChangedPathSegment = (text: string): string =>
  [...text]
    .map((character) => {
      const code = character.codePointAt(0)!
      if (character === "\n") return "\\n"
      if (character === "\r") return "\\r"
      if (character === "\t") return "\\t"
      if (code < 32 || (code >= 127 && code <= 159))
        return code <= 255 ? `\\x${code.toString(16).padStart(2, "0")}` : `\\u{${code.toString(16)}}`
      return character
    })
    .join("")

const fileTreeRows = (
  files: ReadonlyArray<import("./view-state").ChangedFile>,
  innerWidth: number,
  showCounts: boolean,
): ReadonlyArray<ChangedFileRow> => {
  if (files.length === 0) return [{ chunks: [fg(colors.muted)("No changes")] }]
  const root: ChangedNode = { children: new Map() }
  for (const file of [...files].toSorted((a, b) => a.path.localeCompare(b.path))) {
    const segments = file.path.split("/")
    let node = root
    segments.forEach((segment, index) => {
      let child = node.children.get(segment)
      if (child === undefined) {
        child = { children: new Map() }
        node.children.set(segment, child)
      }
      if (index === segments.length - 1) child.file = file
      node = child
    })
  }
  const rows: Array<ChangedFileRow> = []
  const walk = (node: ChangedNode, depth: number) => {
    for (const [name, child] of node.children) {
      const indent = "  ".repeat(depth)
      const displayName = escapeChangedPathSegment(name)
      const indentChunks = indent.length > 0 ? [fg(colors.text)(indent)] : []
      if (child.file === undefined) {
        rows.push({
          chunks: [
            ...indentChunks,
            fg(colors.muted)(truncateToWidth(`${displayName}/`, Math.max(1, innerWidth - indent.length))),
          ],
        })
        walk(child, depth + 1)
      } else {
        const hasCounts = child.file.added !== undefined || child.file.removed !== undefined
        if (!showCounts || !hasCounts) {
          rows.push({
            chunks: [
              ...indentChunks,
              fg(changedFileColor(child.file.status))(
                truncateToWidth(displayName, Math.max(1, innerWidth - indent.length)),
              ),
            ],
            file: child.file,
            nameIndex: indentChunks.length,
          })
          continue
        }
        const added = ` +${child.file.added ?? 0}`
        const removed = ` -${child.file.removed ?? 0}`
        const label = truncateToWidth(
          displayName,
          Math.max(1, innerWidth - indent.length - stringWidth(added) - stringWidth(removed)),
        )
        rows.push({
          chunks: [
            ...indentChunks,
            fg(changedFileColor(child.file.status))(label),
            fg(colors.green)(added),
            fg(colors.red)(removed),
          ],
          file: child.file,
          nameIndex: indentChunks.length,
        })
      }
    }
  }
  walk(root, 0)
  return rows
}

const sidebarInnerWidth = (model: Model): number => Math.max(1, fileSidebarLayoutWidth(model) - 8)

const sidebarFileRows = (model: Model, innerWidth: number): ReadonlyArray<ChangedFileRow> =>
  model.changedFilesOpen
    ? fileTreeRows(readyOr(model.changedFiles, []), innerWidth, true)
    : fileTreeRows(
        readyOr(model.filePicker.items, []).map((path) => ({ path, status: "" })),
        innerWidth,
        false,
      )

const renderFileRows = (rows: ReadonlyArray<ChangedFileRow>, hoveredRow?: number): StyledText => {
  const chunks: Array<TextChunk> = []
  for (const [index, row] of rows.entries()) {
    if (index > 0) chunks.push(fg(colors.text)("\n"))
    if (index === hoveredRow && row.file !== undefined && row.nameIndex !== undefined) {
      chunks.push(...row.chunks.map((chunk, chunkIndex) => (chunkIndex === row.nameIndex ? underline(chunk) : chunk)))
    } else {
      chunks.push(...row.chunks)
    }
  }
  return new StyledText(chunks)
}

export const renderChangedFiles: {
  (model: Model, innerWidth: number, hoveredRow?: number): StyledText
  (innerWidth: number, hoveredRow?: number): (model: Model) => StyledText
} = Function.dual(
  (args) => args.length > 1 && typeof args[0] !== "number",
  (model: Model, innerWidth: number, hoveredRow?: number): StyledText =>
    renderFileRows(fileTreeRows(readyOr(model.changedFiles, []), innerWidth, true), hoveredRow),
)

export const renderTranscript = (model: Model): string => {
  const welcome = model.entries.length === 0 ? `Rika\nLocal durable coding agent\n\n` : ""
  const entries = model.entries
    .map((entry) =>
      entry.role === "user"
        ? `┃ ${entry.text}`
        : entry.role === "notice"
          ? `! ${entry.text}`
          : renderMarkdown(entry.text, markdownWidthForColumn(model.width)),
    )
    .join("\n\n")
  const blocks = (model.blocks as ReadonlyArray<TranscriptBlock>)
    .map((block) => {
      if (block._tag === "Permission" && block.status === "pending") {
        const options = ["Allow once", "Always", "Deny"]
          .map((option, index) => `${index === model.permissionSelection ? "›" : " "} ${option}`)
          .join("   ")
        return `${renderBlock(block, model.width)}\n  ${options}`
      }
      return renderBlock(block, model.width)
    })
    .join("\n\n")
  if (model.items.length === 0)
    return welcome + entries + (blocks.length === 0 ? "" : `${model.entries.length === 0 ? "" : "\n\n"}${blocks}`)
  const ordered = (model.items as ReadonlyArray<TranscriptItem>).map((item) => {
    if (item._tag === "Block") return renderBlock(model.blocks[item.index] as TranscriptBlock, model.width)
    const entry = model.entries[item.index]!
    return entry.role === "user"
      ? `┃ ${entry.text}`
      : entry.role === "notice"
        ? `! ${entry.text}`
        : renderMarkdown(entry.text, markdownWidthForColumn(model.width))
  })
  return welcome + ordered.join("\n\n")
}

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

type ToolUnit = {
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
  return block.detail || inputString(value, ["command", "cmd", "script"]) || block.input
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

const plural = (count: number, singular: string): string => `${count} ${singular}${count === 1 ? "" : "s"}`

const iconChar = (failed: boolean, running: boolean, frame = idleSpinnerFrame, cancelled = false): string =>
  running ? frame : cancelled ? "⊘" : failed ? "✕" : "✓"

const markerText = (expanded: boolean): string => (expanded ? " ▾" : " ▸")

const cancelledAgentLabel = (activeLabel: string): string => `${activeLabel.split(" ")[0] ?? "Subagent"} cancelled`
const failedAgentLabel = (activeLabel: string): string => `${activeLabel.split(" ")[0] ?? "Subagent"} failed`

export interface UnitLineRange {
  readonly start: number
  readonly end: number
  readonly unit: string
  readonly expandable: boolean
  readonly animated?: boolean
  readonly gapBefore?: boolean
  readonly targets?: ReadonlyArray<PathTarget>
}

export const maxMountedTranscriptEntries = 200

export const boundedTranscriptModel: {
  (model: Model): Model
  (model: Model, end: number): Model
  (end: number): (model: Model) => Model
} = Function.dual(
  (args) => typeof args[0] === "object",
  (model: Model, end = model.items.length): Model => {
    const limit = maxMountedTranscriptEntries
    if (model.items.length === 0)
      return {
        ...model,
        entries: model.entries.slice(-limit),
        blocks: model.blocks.slice(-limit),
      }
    const windowEnd = Math.min(model.items.length, Math.max(0, Math.floor(end)))
    const allItems = model.items as ReadonlyArray<TranscriptItem>
    let source = allItems.slice(Math.max(0, windowEnd - limit), windowEnd)
    const parentItems = new Map<string, { readonly item: TranscriptItem; readonly position: number }>()
    for (const [position, item] of allItems.entries()) {
      if (item._tag !== "Block") continue
      const block = model.blocks[item.index] as TranscriptBlock | undefined
      if (block?._tag === "ToolCall") parentItems.set(block.id, { item, position })
    }
    const included = new Set(source)
    const ancestors: Array<{ readonly item: TranscriptItem; readonly position: number }> = []
    for (let cursor = 0; cursor < source.length + ancestors.length; cursor += 1) {
      const item = cursor < source.length ? source[cursor] : ancestors[cursor - source.length]?.item
      if (item?.parentId === undefined) continue
      const parent = parentItems.get(item.parentId)
      if (parent === undefined || included.has(parent.item)) continue
      included.add(parent.item)
      ancestors.push(parent)
    }
    if (ancestors.length > 0)
      source = [
        ...ancestors.toSorted((left, right) => left.position - right.position).map(({ item }) => item),
        ...source,
      ]
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

const toolUnitsFor = (model: Model, indices: ReadonlyArray<number>): ReadonlyArray<ToolUnit> =>
  indices.map((index) => {
    const block = model.blocks[index] as Extract<TranscriptBlock, { _tag: "ToolCall" }>
    return { kind: toolKind(block.name, undefined), block, index }
  })

export const buildTranscript: {
  (model: Model, spinnerFrame?: string): { styled: StyledText; ranges: ReadonlyArray<UnitLineRange> }
  (spinnerFrame?: string): (model: Model) => { styled: StyledText; ranges: ReadonlyArray<UnitLineRange> }
} = Function.dual(
  (args) => typeof args[0] !== "string",
  (model: Model, spinnerFrame = idleSpinnerFrame): { styled: StyledText; ranges: ReadonlyArray<UnitLineRange> } => {
    const chunks: Array<TextChunk> = []
    let line = 0
    const append = (chunk: TextChunk) => {
      chunks.push(chunk)
      line += chunk.text.split("\n").length - 1
    }
    const appendAll = (styled: StyledText) => {
      for (const chunk of styled.chunks) append(chunk)
    }
    const addExpandedBodyGutter = (from: number) => {
      const body = chunks.splice(from)
      const bordered: Array<TextChunk> = []
      for (const chunk of body) {
        const parts = chunk.text.split("\n")
        for (const [index, part] of parts.entries()) {
          if (index > 0) {
            bordered.push(fg(colors.text)("\n"))
            bordered.push(dim(fg(colors.subtle)("│ ")))
          }
          if (part.length > 0) bordered.push({ ...chunk, text: part })
        }
      }
      chunks.push(...bordered)
    }
    let renderedUnits = 0
    const newBlockGap = () => {
      if (renderedUnits > 0) append(fg(colors.text)("\n\n"))
      renderedUnits += 1
    }
    const statusIcon = (failed: boolean, running: boolean, cancelled = false): TextChunk =>
      running
        ? fg(colors.blue)(spinnerFrame)
        : cancelled
          ? fg(colors.amber)("⊘")
          : failed
            ? fg(colors.red)("✕")
            : fg(colors.green)("✓")
    const marker = (expanded: boolean): TextChunk => fg(colors.subtle)(expanded ? " ▾" : " ▸")
    const rowExpanded = (id: string): boolean => model.expandedRowKeys.includes(id)
    const highlight = (text: string) => append(bold(fg(colors.blue)(text)))
    let nestedRanges: Array<UnitLineRange> = []
    const renderEntryBody = (index: number) => {
      const entry = model.entries[index]!
      if (entry.role === "assistant") {
        appendAll(renderMarkdownStyled(entry.text.trimEnd(), markdownWidthForColumn(model.width)))
        return
      }
      if (entry.role === "notice") {
        if (entry.text === "cancelled") append(fg(colors.amber)("⊘"))
        else append(fg(colors.amber)(`! ${entry.text}`))
        return
      }
      const wrapWidth = markdownWidthForColumn(model.width)
      const wrapped = entry.text.split("\n").flatMap((current) => {
        if (current.length <= wrapWidth) return [current]
        const parts: Array<string> = []
        let rest = current
        while (rest.length > wrapWidth) {
          const slice = rest.slice(0, wrapWidth)
          const breakAt = slice.lastIndexOf(" ") > wrapWidth / 2 ? slice.lastIndexOf(" ") : wrapWidth
          parts.push(rest.slice(0, breakAt))
          rest = rest.slice(breakAt).trimStart()
        }
        parts.push(rest)
        return parts
      })
      wrapped.forEach((current, lineIndex) => {
        if (lineIndex > 0) append(fg(colors.text)("\n"))
        append(fg(colors.green)("┃ "))
        append(italic(fg(colors.green)(current)))
      })
    }
    const renderAgentResponse = (index: number, prefix: string, gap = false): UnitLineRange | undefined => {
      const entry = model.entries[index]
      if (entry?.role !== "assistant" || entry.text.trim().length === 0) return
      const item = orderedTranscriptItems(model).find(
        (candidate) => candidate._tag === "Entry" && candidate.index === index,
      )
      const rows = renderMarkdownLines(
        entry.text.trimEnd(),
        Math.max(1, markdownWidthForColumn(model.width) - stringWidth(prefix)),
      )
      const curl = gap ? `${prefix.slice(0, -2)}╰ ` : prefix
      if (gap) {
        append(fg(colors.text)("\n"))
        append(dim(fg(colors.subtle)(prefix.trimEnd())))
      }
      const start = line + 1
      rows.forEach((row, rowIndex) => {
        append(fg(colors.text)("\n"))
        append(dim(fg(colors.subtle)(rowIndex === rows.length - 1 ? curl : prefix)))
        for (const chunk of row) append(chunk)
      })
      return {
        start,
        end: line,
        unit: `entry:${item?.id ?? `${entry.turnId ?? "child"}:assistant:${index}`}`,
        expandable: false,
      }
    }
    const renderExploreBody = (units: ReadonlyArray<ToolUnit>, selected: boolean, expanded: boolean) => {
      const running = units.some((unit) => unit.block.status === "running")
      const cancelled = units.some((unit) => unit.block.status === "cancelled")
      const counters = new Map<string, number>()
      for (const unit of units) {
        const counter = unit.block.presentation.counter ?? (unit.kind === "read" ? "file" : "search")
        counters.set(counter, (counters.get(counter) ?? 0) + 1)
      }
      const counts = [...counters]
        .map(([counter, count]) =>
          counter === "search" ? plural(count, counter).replace("searchs", "searches") : plural(count, counter),
        )
        .join(", ")
      if (selected)
        highlight(
          `${iconChar(false, running, spinnerFrame, cancelled)} ${running ? "Exploring" : "Explored"} ${counts.length > 0 ? counts : "workspace"}${markerText(expanded)}`,
        )
      else {
        append(statusIcon(false, running, cancelled))
        append(fg(colors.text)(running ? " Exploring" : " Explored"))
        append(dim(fg(colors.text)(` ${counts.length > 0 ? counts : "workspace"}`)))
        append(marker(expanded))
      }
      if (expanded)
        for (const unit of units) {
          append(fg(colors.text)("\n "))
          const start = line
          append(
            statusIcon(
              unit.block.status === "failed",
              unit.block.status === "running",
              unit.block.status === "cancelled",
            ),
          )
          const label = exploreChildLabel(unit)
          const childId = `tool-child:${unit.block.id}`
          const verbEnd = label.indexOf(" ")
          if (verbEnd === -1) append(fg(colors.text)(` ${label}`))
          else {
            append(fg(colors.text)(` ${label.slice(0, verbEnd)}`))
            append(dim(fg(colors.text)(label.slice(verbEnd))))
          }
          const output =
            unit.block.status === "failed"
              ? unit.block.output?.split("\n").find((value) => value.length > 0)
              : undefined
          if (output !== undefined) append(dim(fg(colors.text)(` ${output}`)))
          const detail = toolDetails(model, { kind: "tool", group: "explore", blocks: [unit.index], diffs: [] })[0]
          nestedRanges.push({
            start,
            end: line,
            unit: childId,
            expandable: false,
            animated: unit.block.status === "running",
            ...(detail?.target === undefined ? {} : { targets: [detail.target] }),
          })
        }
    }
    const renderEditBody = (
      units: ReadonlyArray<ToolUnit>,
      diffs: ReadonlyArray<number>,
      selected: boolean,
      expanded: boolean,
    ) => {
      const failed = units.some((unit) => unit.block.status === "failed")
      const running = units.some((unit) => unit.block.status === "running")
      const cancelled = units.some((unit) => unit.block.status === "cancelled")
      const paths = [
        ...new Set(
          units.flatMap((unit) =>
            unit.block.files.length > 0
              ? unit.block.files.map((file) => file.path)
              : [inputString(toolInputValue(unit.block.input), ["path", "file_path", "file"]) ?? unit.block.name],
          ),
        ),
      ]
      const allFiles = units.flatMap((unit) => unit.block.files)
      let added = 0
      let removed = 0
      for (const file of allFiles) {
        added += file.additions
        removed += file.deletions
      }
      for (const diffIndex of diffs) {
        const diff = model.blocks[diffIndex] as Extract<TranscriptBlock, { _tag: "Diff" }>
        const [a, r] = diffCounts(diff.patch)
        added += a
        removed += r
      }
      const creates = diffs.length === 0 && allFiles.length > 0 && allFiles.every((file) => file.kind === "add")
      const label = paths.length === 1 ? paths[0] : plural(paths.length, "file")
      const verb = creates
        ? running
          ? "Creating"
          : "Created"
        : paths.length === 1 && units.length === 1
          ? running
            ? units[0]!.block.presentation.activeLabel
            : units[0]!.block.presentation.completeLabel
          : running
            ? "Editing"
            : "Edited"
      const counts = `${added > 0 ? ` +${added}` : ""}${removed > 0 ? ` -${removed}` : ""}`
      if (selected)
        highlight(
          `${iconChar(failed, running, spinnerFrame, cancelled)} ${verb} ${label}${counts}${markerText(expanded)}`,
        )
      else {
        append(statusIcon(failed, running, cancelled))
        append(fg(colors.text)(` ${verb}`))
        append(dim(fg(colors.text)(` ${label}`)))
        if (added > 0) append(fg(colors.green)(` +${added}`))
        if (removed > 0) append(fg(colors.red)(` -${removed}`))
        append(marker(expanded))
      }
      if (expanded) {
        const files = allFiles
        if (files.length === 1) {
          const file = files[0]!
          if (file.patch.length > 0) {
            append(fg(colors.text)("\n"))
            appendAll(
              renderPierreDiff(file.patch, model.width) ??
                (file.preview ? renderPartialDiffStyled(file.patch, model.width) : undefined) ??
                renderDiffStyled(file.patch, model.width),
            )
          }
        } else {
          for (const file of files) {
            append(fg(colors.text)("\n  "))
            const start = line
            const childId = `file:${file.key}`
            const childExpanded = rowExpanded(childId) || running
            const fileRunning = running && file.status === "running"
            append(statusIcon(file.status === "failed", fileRunning, cancelled && file.status === "running"))
            append(fg(colors.text)(` ${file.kind === "add" ? "Create" : "Edit"} ${file.path}`))
            if (file.additions > 0) append(fg(colors.green)(` +${file.additions}`))
            if (file.deletions > 0) append(fg(colors.red)(` -${file.deletions}`))
            append(marker(childExpanded))
            if (childExpanded && file.patch.length > 0) {
              append(fg(colors.text)("\n"))
              appendAll(
                renderPierreDiff(file.patch, model.width) ??
                  (file.preview ? renderPartialDiffStyled(file.patch, model.width) : undefined) ??
                  renderDiffStyled(file.patch, model.width),
              )
            }
            nestedRanges.push({
              start,
              end: line,
              unit: childId,
              expandable: true,
              animated: fileRunning,
              targets: [{ path: file.path }],
            })
          }
        }
        for (const diffIndex of diffs) {
          const diff = model.blocks[diffIndex] as Extract<TranscriptBlock, { _tag: "Diff" }>
          append(fg(colors.text)("\n"))
          const start = line
          appendAll(renderPierreDiff(diff.patch, model.width) ?? renderDiffStyled(diff.patch, model.width))
          nestedRanges.push({
            start,
            end: line,
            unit: `diff-child:${diffIndex}`,
            expandable: false,
            targets: [{ path: diff.path }],
          })
        }
      }
    }
    const renderShellSingleBody = (unit: ToolUnit, selected: boolean, expanded: boolean) => {
      const command = shellCommandText(unit.block)
      const failed = unit.block.status === "failed"
      const running = unit.block.status === "running"
      const cancelled = unit.block.status === "cancelled"
      const lines = command.split("\n")
      const expandable = unit.block.output !== undefined && unit.block.output.length > 0
      const exitCode = shellExitCode(unit.block)
      if (selected) {
        const exit = failed ? ` (exit code: ${exitCode ?? 1})` : ""
        const cancellation = cancelled ? " (cancelled)" : ""
        highlight(
          `${running ? spinnerFrame : "$"} ${lines.join("\n    ")}${exit}${cancellation}${expandable ? markerText(expanded) : ""}`,
        )
      } else {
        lines.forEach((current, lineIndex) => {
          if (lineIndex === 0) {
            if (running) {
              append(statusIcon(false, true))
              append(fg(colors.text)(" "))
            } else if (cancelled) append(bold(fg(colors.amber)("$ ")))
            else append(dim(fg(colors.text)("$ ")))
            append(cancelled ? strikethrough(fg(colors.text)(current)) : fg(colors.text)(current))
          } else
            append(cancelled ? strikethrough(fg(colors.text)(`\n    ${current}`)) : fg(colors.text)(`\n    ${current}`))
        })
        if (failed) append(fg(colors.red)(` (exit code: ${exitCode ?? 1})`))
        if (cancelled) append(italic(fg(colors.amber)(" (cancelled)")))
        if (expandable) append(marker(expanded))
      }
      if (expanded && unit.block.output !== undefined) {
        append(fg(colors.text)("\n"))
        append(dim(fg(colors.text)(unit.block.output.split("\n").slice(0, 12).join("\n"))))
      }
    }
    const renderShellBody = (units: ReadonlyArray<ToolUnit>, selected: boolean, expanded: boolean) => {
      if (units.length === 1) {
        renderShellSingleBody(units[0]!, selected, expanded)
        return
      }
      const failedCount = units.filter((unit) => unit.block.status === "failed").length
      const cancelledCount = units.filter((unit) => unit.block.status === "cancelled").length
      const running = units.some((unit) => unit.block.status === "running")
      if (selected)
        highlight(
          `${iconChar(failedCount > 0, running, spinnerFrame, cancelledCount > 0)} ${running ? "Running" : "Ran"} ${plural(units.length, "command")}${failedCount > 0 ? `, ${failedCount} failed` : ""}${cancelledCount > 0 ? `, ${cancelledCount} cancelled` : ""}${markerText(expanded)}`,
        )
      else {
        append(statusIcon(failedCount > 0, running, cancelledCount > 0))
        append(fg(colors.text)(running ? " Running" : " Ran"))
        append(fg(colors.text)(` ${plural(units.length, "command")}`))
        if (failedCount > 0) append(fg(colors.muted)(`, ${failedCount} failed`))
        if (cancelledCount > 0) append(fg(colors.muted)(`, ${cancelledCount} cancelled`))
        append(marker(expanded))
      }
      if (expanded)
        for (const unit of units) {
          append(fg(colors.text)("\n   "))
          const start = line
          const childId = `tool-child:${unit.block.id}`
          const childExpanded = rowExpanded(childId)
          const expandable = unit.block.output !== undefined && unit.block.output.length > 0
          const cancelled = unit.block.status === "cancelled"
          if (cancelled) {
            append(bold(fg(colors.amber)("$ ")))
            append(strikethrough(fg(colors.text)(shellCommandText(unit.block).split("\n")[0]!)))
            append(italic(fg(colors.amber)(" (cancelled)")))
          } else append(fg(colors.text)(`$ ${shellCommandText(unit.block).split("\n")[0]}`))
          if (unit.block.status === "failed") append(fg(colors.red)(` (exit code: ${shellExitCode(unit.block) ?? 1})`))
          if (expandable) append(marker(childExpanded))
          if (expandable && childExpanded) {
            append(fg(colors.text)("\n   "))
            append(dim(fg(colors.text)(unit.block.output!.split("\n").slice(0, 12).join("\n   "))))
          }
          nestedRanges.push({ start, end: line, unit: childId, expandable })
        }
    }
    const renderOtherToolBody = (
      unit: ToolUnit,
      selected: boolean,
      expanded: boolean,
      hasChildren = false,
      hasResponse = false,
    ) => {
      const failed = unit.block.status === "failed"
      const running = unit.block.status === "running"
      const cancelled = unit.block.status === "cancelled"
      const label = running
        ? unit.block.presentation.activeLabel
        : cancelled && unit.block.presentation.family === "agent"
          ? cancelledAgentLabel(unit.block.presentation.activeLabel)
          : failed && unit.block.presentation.family === "agent"
            ? failedAgentLabel(unit.block.presentation.activeLabel)
            : unit.block.presentation.completeLabel
      const detail = unit.block.detail.length === 0 ? "" : ` ${unit.block.detail}`
      const agent = unit.block.presentation.family === "agent"
      const output = agent ? (hasResponse ? undefined : visibleAgentOutput(unit.block.output)) : unit.block.output
      const expandable =
        hasChildren ||
        (agent
          ? unit.block.detail.length > 0 || (failed && output !== undefined && output.length > 0)
          : unit.block.output !== undefined && unit.block.output.length > 0)
      if (selected)
        highlight(
          `${iconChar(failed, running, spinnerFrame, cancelled)} ${label}${agent ? "" : detail}${expandable ? markerText(expanded) : ""}`,
        )
      else {
        append(statusIcon(failed, running, cancelled))
        append(fg(colors.text)(` ${label}`))
        if (!agent && detail.length > 0) append(dim(fg(colors.text)(detail)))
        if (expandable) append(marker(expanded))
      }
      if (expanded && agent && unit.block.detail.length > 0) {
        append(dim(fg(colors.text)(`\n  ${unit.block.detail}`)))
        if (output !== undefined && output.length > 0) {
          const renderedOutput = output.split("\n").slice(0, 12).join("\n  ")
          append(failed ? fg(colors.red)(`\n  ${renderedOutput}`) : dim(fg(colors.text)(`\n  ${renderedOutput}`)))
        }
      } else if (expanded && output !== undefined) {
        append(fg(colors.text)("\n"))
        const body = output.split("\n").slice(0, 12).join("\n")
        append(failed && agent ? fg(colors.red)(body) : dim(fg(colors.text)(body)))
      }
    }
    const renderNestedTool = (unit: ToolTranscriptUnit, prefix: string, last: boolean) => {
      const index = unit.blocks[0]!
      const block = model.blocks[index] as Extract<TranscriptBlock, { _tag: "ToolCall" }>
      const id = transcriptUnitId(model, unit)
      const expanded = rowExpanded(id)
      const running = block.status === "running"
      const failed = block.status === "failed"
      const cancelled = block.status === "cancelled"
      const detail = toolDetail(index, block)
      const children = unit.children ?? []
      const output =
        block.presentation.family === "agent" && unit.response !== undefined
          ? undefined
          : block.presentation.family === "agent"
            ? visibleAgentOutput(block.output)
            : block.output
      const expandable =
        children.length > 0 ||
        unit.response !== undefined ||
        (block.presentation.family === "agent" && block.detail.length > 0) ||
        (output !== undefined && output.length > 0)
      append(fg(colors.text)("\n"))
      append(dim(fg(colors.subtle)(`${prefix}${last ? "└" : "├"} `)))
      const start = line
      if (cancelled && block.presentation.family === "shell") {
        const command = detail.label.startsWith("$ ") ? detail.label.slice(2) : detail.label
        append(bold(fg(colors.amber)("$ ")))
        append(strikethrough(fg(colors.text)(command)))
        append(italic(fg(colors.amber)(" (cancelled)")))
      } else {
        append(statusIcon(failed, running, cancelled))
        append(fg(colors.text)(` ${detail.label}`))
      }
      if (expandable) append(marker(expanded))
      const rangeIndex = nestedRanges.length
      nestedRanges.push({
        start,
        end: start,
        unit: id,
        expandable,
        animated: running,
        ...(detail.target === undefined ? {} : { targets: [detail.target] }),
      })
      const bodyPrefix = `${prefix}${last ? "  " : "│ "}`
      if (expanded && block.presentation.family === "agent" && block.detail.length > 0) {
        append(fg(colors.text)("\n"))
        append(dim(fg(colors.subtle)(`${bodyPrefix}  `)))
        append(dim(fg(colors.text)(block.detail)))
      } else if (expanded && output !== undefined && output.length > 0) {
        const renderedOutput = output.split("\n").slice(0, 12).join(`\n${bodyPrefix}  `)
        append(fg(colors.text)("\n"))
        append(dim(fg(colors.subtle)(`${bodyPrefix}  `)))
        append(dim(fg(colors.text)(renderedOutput)))
      }
      if (expanded)
        for (const [childIndex, child] of children.entries())
          renderNestedTool(child, bodyPrefix, childIndex === children.length - 1)
      if (expanded && unit.response !== undefined) {
        const timeline = children.length > 0
        const response = renderAgentResponse(unit.response, timeline ? `${bodyPrefix}│ ` : `${bodyPrefix}  `, timeline)
        if (response !== undefined) nestedRanges.push(response)
      }
      nestedRanges[rangeIndex] = {
        ...nestedRanges[rangeIndex]!,
        end: children.length === 0 ? line : (nestedRanges[rangeIndex + 1]?.start ?? start + 1) - 1,
      }
    }
    const renderChildAgentBody = (block: Extract<TranscriptBlock, { _tag: "ChildAgent" }>, expanded: boolean) => {
      const running = block.status === "running"
      const name = block.name.replace(/^rika-/, "")
      const normalized = name.toLowerCase()
      const display =
        normalized.length === 0 || normalized === "child" || normalized === "task" || normalized === "subagent"
          ? "Subagent"
          : name.charAt(0).toUpperCase() + name.slice(1)
      const phrase =
        block.status === "cancelled"
          ? `${display} cancelled`
          : display === "Oracle"
            ? running
              ? "Oracle exploring"
              : "Oracle has spoken"
            : display === "Librarian"
              ? running
                ? "Librarian is researching"
                : "Librarian researched"
              : `${display} ${running ? "working" : block.status === "failed" ? "failed" : "finished"}`
      append(statusIcon(block.status === "failed", running, block.status === "cancelled"))
      append(fg(colors.text)(` ${phrase}`))
      append(marker(expanded))
      if (expanded) {
        if (block.summary.length > 0) append(dim(fg(colors.text)(`\n  ${block.summary}`)))
        for (const activity of block.activity) append(dim(fg(colors.text)(`\n  ${activity}`)))
      }
    }
    const renderDiffBody = (index: number, selected: boolean, expanded: boolean) => {
      const block = model.blocks[index] as Extract<TranscriptBlock, { _tag: "Diff" }>
      if (expanded) {
        append(bold(fg(selected ? colors.blue : colors.muted)(`Δ ${block.path} ▾\n`)))
        appendAll(renderPierreDiff(block.patch, model.width) ?? renderDiffStyled(block.patch, model.width))
        return
      }
      const [added, removed] = diffCounts(block.patch)
      const verb = /^--- \/dev\/null$/m.test(block.patch) || /^new file mode /m.test(block.patch) ? "Created" : "Edited"
      if (selected) highlight(`✓ ${verb} ${block.path} +${added} -${removed} ▸`)
      else {
        append(fg(colors.green)("✓"))
        append(fg(colors.text)(` ${verb} ${block.path}`))
        append(fg(colors.green)(` +${added}`))
        append(fg(colors.red)(` -${removed}`))
        append(marker(false))
      }
    }
    const renderReasoningBody = (index: number, selected: boolean) => {
      const block = model.blocks[index] as Extract<TranscriptBlock, { _tag: "Reasoning" }>
      append(selected ? bold(fg(colors.blue)(block.text)) : dim(italic(fg(colors.text)(block.text))))
    }
    const renderPlainBlock = (index: number) => {
      const block = model.blocks[index] as TranscriptBlock
      const color = block._tag === "ContextUsage" ? colors.muted : block._tag === "Error" ? colors.red : colors.text
      append(fg(color)(renderBlock(block, model.width)))
      if (block._tag === "Permission" && block.status === "pending") {
        const options = ["Allow once", "Always", "Deny"]
          .map((option, optionIndex) => `${optionIndex === model.permissionSelection ? "›" : " "} ${option}`)
          .join("   ")
        append(fg(colors.text)(`\n  ${options}`))
      }
    }
    const units = transcriptUnits(model)
    const ranges: Array<UnitLineRange> = []
    if (orderedTranscriptItems(model)[0]?._tag === "Block") append(fg(colors.text)("\n"))
    for (const unit of units) {
      const expandable = isExpandableUnit(unit)
      const id = transcriptUnitId(model, unit)
      const expanded =
        rowExpanded(id) ||
        (unit.kind === "tool" &&
          unit.group === "edit" &&
          unit.blocks.some(
            (block) => (model.blocks[block] as Extract<TranscriptBlock, { _tag: "ToolCall" }>).status === "running",
          ))
      const selected = expandable && model.detailSelection === id
      if (unit.kind === "reasoning" && !expanded) continue
      newBlockGap()
      const start = line
      const chunkStart = chunks.length
      nestedRanges = []
      if (unit.kind === "entry") renderEntryBody(unit.entry)
      else if (unit.kind === "reasoning") renderReasoningBody(unit.block, selected)
      else if (unit.kind === "childAgent")
        renderChildAgentBody(model.blocks[unit.block] as Extract<TranscriptBlock, { _tag: "ChildAgent" }>, expanded)
      else if (unit.kind === "diff") renderDiffBody(unit.block, selected, expanded)
      else if (unit.kind === "block") renderPlainBlock(unit.block)
      else if (unit.children !== undefined || unit.response !== undefined) {
        renderOtherToolBody(
          toolUnitsFor(model, unit.blocks)[0]!,
          selected,
          expanded,
          unit.children !== undefined,
          unit.response !== undefined,
        )
        if (expanded)
          for (const [childIndex, child] of (unit.children ?? []).entries())
            renderNestedTool(child, "  ", childIndex === (unit.children?.length ?? 0) - 1)
        if (expanded && unit.response !== undefined) {
          const timeline = (unit.children?.length ?? 0) > 0
          const response = renderAgentResponse(unit.response, timeline ? "  │ " : "  ", timeline)
          if (response !== undefined) nestedRanges.push(response)
        }
      } else if (unit.group === "explore") renderExploreBody(toolUnitsFor(model, unit.blocks), selected, expanded)
      else if (unit.group === "edit") renderEditBody(toolUnitsFor(model, unit.blocks), unit.diffs, selected, expanded)
      else if (unit.group === "shell") renderShellBody(toolUnitsFor(model, unit.blocks), selected, expanded)
      else for (const toolUnit of toolUnitsFor(model, unit.blocks)) renderOtherToolBody(toolUnit, selected, expanded)
      const cancelledAgent =
        unit.kind === "tool" &&
        unit.blocks.some((index) => {
          const block = model.blocks[index] as Extract<TranscriptBlock, { _tag: "ToolCall" }>
          return block.status === "cancelled" && block.presentation.family === "agent"
        })
      if (expanded && cancelledAgent) addExpandedBodyGutter(chunkStart)
      ranges.push({
        start,
        end: nestedRanges.length === 0 ? line : nestedRanges[0]!.start - 1,
        unit: id,
        expandable,
        animated:
          unit.kind === "tool"
            ? unit.blocks.some(
                (index) => (model.blocks[index] as Extract<TranscriptBlock, { _tag: "ToolCall" }>).status === "running",
              )
            : unit.kind === "childAgent"
              ? (model.blocks[unit.block] as Extract<TranscriptBlock, { _tag: "ChildAgent" }>).status === "running"
              : false,
        gapBefore: renderedUnits > 1,
        ...(unit.kind === "tool"
          ? {
              targets: toolDetails(model, unit).flatMap((detail) =>
                detail.target === undefined ? [] : [detail.target],
              ),
            }
          : unit.kind === "diff"
            ? { targets: [{ path: (model.blocks[unit.block] as Extract<TranscriptBlock, { _tag: "Diff" }>).path }] }
            : {}),
      })
      ranges.push(...nestedRanges)
    }
    return { styled: new StyledText(chunks), ranges }
  },
)

export const renderTranscriptStyled = (model: Model): StyledText => buildTranscript(model).styled

export interface Handlers {
  readonly key: (key: Key) => void
  readonly scroll?: (offset: number) => void
  readonly scrollGeometry?: (offset: number) => void
  readonly scrollFollow?: () => void
  readonly paste?: (text: string) => void
  readonly pasteImage?: (image?: { readonly bytes: Uint8Array; readonly mediaType?: string }) => void
  readonly expandPaste?: (token: string) => void
  readonly clickToggle?: (unit: string) => void
  readonly composerResize?: (height: number) => void
  readonly sidebarResize?: (width: number) => void
  readonly threadSidebarSelect?: (index: number) => void
  readonly threadPreviewScroll?: (offset: number) => void
  readonly openPath?: (target: PathTarget) => void
  readonly resize: (width: number, height: number) => void
}

export interface SurfaceOptions {
  readonly animate?: boolean
  readonly clock?: OpenTuiClock
}

interface TranscriptRenderableRecord {
  readonly key: string
  revision: string
  readonly renderable: TextRenderable
  spinnerChunk?: number
}

interface TranscriptRenderableDescriptor {
  readonly key: string
  readonly revision: string
  readonly content: StyledText
  readonly selectable?: boolean
  readonly spinnerChunk?: number
  readonly targets?: ReadonlyArray<PathTarget>
  readonly onMouseDown?: TextRenderable["onMouseDown"]
}

interface TranscriptAnchor {
  readonly key: string
  readonly screenY: number
}

interface PendingTranscriptAnchor {
  readonly anchor: TranscriptAnchor | undefined
  readonly threadId: string | undefined
  readonly scrollHeight: number
  readonly scrollBy: number
}

interface TranscriptRenderInput {
  readonly entries: Model["entries"]
  readonly blocks: Model["blocks"]
  readonly items: Model["items"]
  readonly expandedRowKeys: Model["expandedRowKeys"]
  readonly detailSelection: Model["detailSelection"]
  readonly permissionSelection: number
  readonly width: number
  readonly windowEnd: number
}

const mouseSequencePattern = new RegExp(`^(?:${String.fromCharCode(27)}?\\[)?<?\\d+(?:;\\d+)*[Mm]?$`)
const typingCursorStyle = { style: "block", blinking: false } as const

const visibleAgentOutput = (output: string | undefined): string | undefined => {
  if (output === undefined) return undefined
  const value = output.trim()
  if (!(value.startsWith("{") || value.startsWith("["))) return output
  try {
    const decoded: unknown = JSON.parse(value)
    if (typeof decoded === "object" && decoded !== null && "output" in decoded && Array.isArray(decoded.output)) {
      const text = decoded.output
        .flatMap((part) =>
          typeof part === "object" && part !== null && "text" in part && typeof part.text === "string"
            ? [part.text]
            : [],
        )
        .join("\n")
      if (text.length > 0) return text
    }
    return typeof decoded === "object" && decoded !== null ? undefined : output
  } catch {
    return output
  }
}

const cutoutBackground = (renderer: CliRenderer): RGBA => {
  const background: unknown = Reflect.get(renderer, "backgroundColor")
  return background instanceof RGBA && background.a > 0 ? RGBA.defaultBackground(background) : RGBA.defaultBackground()
}

class SidebarScrollBoxRenderable extends ScrollBoxRenderable {
  onWindowChanged: (() => void) | undefined
  private virtualHeight = 0

  override get scrollHeight(): number {
    return this.virtualHeight
  }

  override get scrollTop(): number {
    return super.scrollTop
  }

  override set scrollTop(value: number) {
    this.applyVirtualGeometry()
    super.scrollTop = value
    this.content.translateY = 0
    this.onWindowChanged?.()
  }

  setVirtualHeight(value: number): void {
    const height = Math.max(0, Math.floor(value))
    this.virtualHeight = height
    if (this.applyVirtualGeometry()) this.onWindowChanged?.()
  }

  syncVirtualScroll(): void {
    if (this.applyVirtualGeometry()) this.onWindowChanged?.()
  }

  override render(...args: Parameters<ScrollBoxRenderable["render"]>): void {
    this.applyVirtualGeometry()
    super.render(...args)
  }

  private applyVirtualGeometry(): boolean {
    const previousTop = super.scrollTop
    this.verticalScrollBar.viewportSize = this.viewport.height
    this.verticalScrollBar.scrollSize = Math.max(this.virtualHeight, this.viewport.height)
    this.verticalScrollBar.scrollPosition = Math.min(
      previousTop,
      Math.max(0, this.virtualHeight - this.viewport.height),
    )
    this.content.translateY = 0
    return super.scrollTop !== previousTop
  }
}

class ProjectedEditorRenderable extends EditBufferRenderable {
  sync(text: string, cursor: number): void {
    if (this.plainText !== text) this.setText(text)
    this.cursorOffset = Math.max(0, Math.min(text.length, cursor))
  }
}

export class Surface {
  readonly main: BoxRenderable
  readonly contentColumn: BoxRenderable
  readonly transcriptRow: BoxRenderable
  readonly transcriptScroll: ScrollBoxRenderable
  readonly transcriptScrollbar: ScrollBarRenderable
  readonly transcriptContent: BoxRenderable
  readonly input: TextRenderable
  readonly composerEditor: ProjectedEditorRenderable
  readonly inputBox: BoxRenderable
  readonly queueBox: BoxRenderable
  readonly queueText: TextRenderable
  readonly queueHint: TextRenderable
  readonly queueLeftJoint: TextRenderable
  readonly queueRightJoint: TextRenderable
  readonly modeLabel: TextRenderable
  readonly workspaceLabel: TextRenderable
  readonly paletteBox: BoxRenderable
  readonly palette: TextRenderable
  readonly overlayEditor: ProjectedEditorRenderable
  readonly sidebar: TextRenderable
  readonly changedFilesBox: SidebarScrollBoxRenderable
  readonly changedFilesText: TextRenderable
  readonly statusLabel: TextRenderable
  readonly toastBox: BoxRenderable
  readonly toast: TextRenderable
  private welcomePhase = 0
  private welcomeChild: TextRenderable | undefined
  private welcomeKey = ""
  private welcomeTimer: Fiber.Fiber<void> | undefined
  private toastTimer: Fiber.Fiber<void> | undefined
  private lastPaste: { readonly text: string; readonly at: number } | undefined
  private model: Model | undefined
  private transcriptChildren: Array<TextRenderable> = []
  private transcriptRecords = new Map<string, TranscriptRenderableRecord>()
  private transcriptRenderInput: TranscriptRenderInput | undefined
  private composerDrag: { readonly startY: number; readonly startHeight: number } | undefined
  private sidebarDrag: { readonly startX: number; readonly startWidth: number } | undefined
  private pointerShape = "default"
  private changedRows: ReadonlyArray<ChangedFileRow> = []
  private changedFilesHoveredRow: number | undefined
  private sidebarRowsSource: unknown
  private sidebarRowsView: "changed" | "workspace" | undefined
  private sidebarRowsWidth = 0
  private sidebarWindowStart = -1
  private sidebarWindowEnd = -1
  private sidebarWindowHoveredRow: number | undefined
  private sidebarLayoutFrame: (() => void) | undefined
  private scrollProgrammatic = false
  private scrollFramePending = false
  private wheelTimer: TimerHandle | undefined
  private wheelDirection: "up" | "down" | undefined
  private wheelScrollBy = 0
  private userScrollDetached = false
  private loaderPhase = 0
  private loaderTimer: TimerHandle | undefined
  private readonly clock: OpenTuiClock
  private readonly toolSpinner = new ToolSpinner()
  private transcriptViewportRows = 0
  private transcriptWindowEnd = 0
  private transcriptWindowThread: string | undefined
  private transcriptAnchorFrame: (() => void) | undefined
  private transcriptAnchorScrollBy = 0
  private pendingTranscriptAnchor: PendingTranscriptAnchor | undefined
  private scrollbarSyncing = false
  private scrollGeneration = 0
  private destroyed = false
  private focusedEditor: ProjectedEditorRenderable | undefined
  private cursorTimer: Fiber.Fiber<void> | undefined
  private cursorGeneration = 0

  constructor(
    private readonly renderer: CliRenderer,
    private readonly handlers: Handlers,
    private readonly options: SurfaceOptions = {},
  ) {
    this.clock = options.clock ?? new SystemClock()
    this.main = new BoxRenderable(renderer, { flexGrow: 1, flexDirection: "row" })
    this.contentColumn = new BoxRenderable(renderer, { flexGrow: 1, flexDirection: "column" })
    this.transcriptRow = new BoxRenderable(renderer, { flexGrow: 1, flexDirection: "row" })
    this.transcriptScroll = new ScrollBoxRenderable(renderer, {
      flexGrow: 1,
      scrollY: true,
      stickyScroll: true,
      stickyStart: "bottom",
      viewportCulling: true,
      verticalScrollbarOptions: { visible: false },
      contentOptions: { flexDirection: "column", justifyContent: "flex-end" },
      onMouseScroll: (event) => this.handleTranscriptWheel(event),
    })
    this.transcriptScroll.verticalScrollBar.visible = false
    this.transcriptContent = new BoxRenderable(renderer, {
      flexDirection: "column",
      paddingTop: spacing.transcript,
      paddingBottom: 0,
      paddingLeft: spacing.transcript,
      paddingRight: spacing.transcript + 1,
    })
    this.transcriptScroll.add(this.transcriptContent)
    this.transcriptScrollbar = new ScrollBarRenderable(renderer, {
      orientation: "vertical",
      showArrows: false,
      position: "absolute",
      top: 0,
      bottom: 0,
      right: 0,
      width: 1,
      visible: false,
      trackOptions: { foregroundColor: colors.text, backgroundColor: colors.muted },
      onChange: (position) => {
        if (this.scrollbarSyncing || this.destroyed) return
        this.transcriptScroll.scrollTop = position
        if (!this.atTranscriptBottom() && this.model?.scrollFollow === true) {
          this.userScrollDetached = true
          this.transcriptScroll.stickyScroll = false
          this.handlers.scroll?.(position)
        } else this.queueTranscriptScroll(() => this.reportTranscriptScroll())
      },
    })
    this.queueBox = new BoxRenderable(renderer, {
      border: true,
      borderStyle: "rounded",
      borderColor: colors.text,
      focusedBorderColor: colors.text,
      minHeight: 3,
      paddingLeft: spacing.inputHorizontal,
      paddingRight: spacing.inputHorizontal,
      marginLeft: 1,
      marginRight: 1,
      marginBottom: -1,
      flexShrink: 0,
      visible: false,
    })
    this.queueText = new TextRenderable(renderer, { content: "", wrapMode: "word", selectable: false })
    this.queueHint = new TextRenderable(renderer, {
      content: "",
      position: "absolute",
      top: 0,
      right: 1,
      zIndex: 10,
      selectable: false,
    })
    this.queueBox.add(this.queueText)
    this.queueBox.add(this.queueHint)
    this.queueLeftJoint = new TextRenderable(renderer, {
      content: "┴",
      position: "absolute",
      left: 1,
      top: 0,
      zIndex: 40,
      fg: colors.text,
      visible: false,
      selectable: false,
    })
    this.queueRightJoint = new TextRenderable(renderer, {
      content: "┴",
      position: "absolute",
      right: 1,
      top: 0,
      zIndex: 40,
      fg: colors.text,
      visible: false,
      selectable: false,
    })
    this.inputBox = new BoxRenderable(renderer, {
      border: true,
      borderStyle: "rounded",
      borderColor: colors.text,
      focusedBorderColor: colors.text,
      minHeight: spacing.inputHeight,
      paddingLeft: spacing.inputHorizontal,
      paddingRight: spacing.inputHorizontal,
      flexShrink: 0,
      overflow: "hidden",
    })
    this.input = new TextRenderable(renderer, { content: "", fg: colors.text, wrapMode: "word", visible: false })
    this.composerEditor = new ProjectedEditorRenderable(renderer, {
      height: 1,
      textColor: colors.text,
      backgroundColor: "transparent",
      selectable: false,
      wrapMode: "word",
      showCursor: true,
      cursorColor: colors.text,
      cursorStyle: typingCursorStyle,
    })
    this.modeLabel = new TextRenderable(renderer, {
      content: "",
      position: "absolute",
      top: 0,
      right: 2,
      zIndex: 30,
      selectable: false,
    })
    this.workspaceLabel = new TextRenderable(renderer, {
      content: "",
      position: "absolute",
      bottom: 0,
      right: 2,
      zIndex: 10,
      selectable: false,
    })
    this.statusLabel = new TextRenderable(renderer, {
      content: "",
      position: "absolute",
      bottom: 0,
      left: 1,
      zIndex: 30,
      selectable: false,
    })
    this.toastBox = new BoxRenderable(renderer, {
      visible: false,
      position: "absolute",
      top: 1,
      right: 2,
      height: 3,
      zIndex: 40,
      border: true,
      borderStyle: "rounded",
      borderColor: colors.green,
      focusedBorderColor: colors.green,
      backgroundColor: colors.surface,
      paddingLeft: 1,
      paddingRight: 1,
      overflow: "hidden",
    })
    this.toast = new TextRenderable(renderer, { content: "", fg: colors.text })
    this.toastBox.add(this.toast)
    this.paletteBox = new BoxRenderable(renderer, {
      visible: false,
      position: "absolute",
      width: 76,
      height: spacing.overlayHeight,
      top: spacing.overlayTop,
      left: 2,
      zIndex: 20,
      border: true,
      borderStyle: "rounded",
      borderColor: colors.text,
      focusedBorderColor: colors.text,
      backgroundColor: colors.surface,
      paddingLeft: 1,
      paddingRight: 1,
      overflow: "hidden",
    })
    this.palette = new TextRenderable(renderer, { content: "", fg: colors.text, wrapMode: "word" })
    this.overlayEditor = new ProjectedEditorRenderable(renderer, {
      visible: false,
      position: "absolute",
      left: 1,
      top: 0,
      width: 1,
      height: 1,
      zIndex: 1,
      textColor: colors.text,
      backgroundColor: "transparent",
      selectable: false,
      wrapMode: "none",
      showCursor: true,
      cursorColor: colors.text,
      cursorStyle: typingCursorStyle,
    })
    this.sidebar = new TextRenderable(renderer, {
      content: "",
      width: boundedThreadSidebarWidth(renderer.terminalWidth),
      flexShrink: 0,
      visible: false,
      fg: colors.text,
      wrapMode: "none",
      selectable: false,
    })
    this.sidebar.onMouseDown = (event) => {
      if (event.button !== 0) return
      const index = (this.model?.threadSidebar.scrollTop ?? 0) + Math.floor(event.y - this.sidebar.screenY)
      if (index < 0 || index >= (this.model?.threads.length ?? 0)) return
      event.stopPropagation()
      this.handlers.threadSidebarSelect?.(index)
    }
    this.changedFilesBox = new SidebarScrollBoxRenderable(renderer, {
      visible: false,
      width: 34,
      flexShrink: 0,
      border: true,
      borderStyle: "rounded",
      borderColor: colors.text,
      focusedBorderColor: colors.text,
      paddingLeft: 1,
      paddingRight: 1,
      scrollY: true,
      viewportCulling: true,
      verticalScrollbarOptions: { marginRight: 1 },
      onMouseScroll: () => this.defer(() => this.refreshSidebarWindow()),
    })
    this.changedFilesBox.onWindowChanged = () => this.refreshSidebarWindow()
    this.changedFilesText = new TextRenderable(renderer, {
      content: "",
      fg: colors.text,
      selectable: false,
      wrapMode: "none",
    })
    this.changedFilesBox.add(this.changedFilesText)
    this.changedFilesBox.verticalScrollBar.on?.("change", () => {
      this.changedFilesBox.syncVirtualScroll()
      this.refreshSidebarWindow()
    })
    this.changedFilesText.onMouseDown = (event) => {
      if (event.button !== 0) return
      const row = this.sidebarWindowStart + Math.floor(event.y - this.changedFilesText.screenY)
      const file = this.changedRows[row]?.file
      if (file === undefined) return
      event.stopPropagation()
      this.handlers.openPath?.({ path: file.path })
    }
    const updateChangedFilesHover = (event: MouseEvent) => {
      const row = this.sidebarWindowStart + Math.floor(event.y - this.changedFilesText.screenY)
      const hoveredRow = this.changedRows[row]?.file === undefined ? undefined : row
      if (hoveredRow === this.changedFilesHoveredRow) return
      this.changedFilesHoveredRow = hoveredRow
      this.refreshSidebarWindow(true)
      this.renderer.setMousePointer(hoveredRow === undefined ? "default" : "pointer")
      this.renderer.requestRender()
    }
    this.changedFilesText.onMouseOver = updateChangedFilesHover
    this.changedFilesText.onMouseMove = updateChangedFilesHover
    this.changedFilesText.onMouseOut = () => {
      if (this.changedFilesHoveredRow === undefined) return
      this.changedFilesHoveredRow = undefined
      this.refreshSidebarWindow(true)
      this.renderer.setMousePointer("default")
      this.renderer.requestRender()
    }
    this.inputBox.onMouseDown = this.onComposerMouseDown
    this.inputBox.onMouseOver = this.onComposerMouseMove
    this.inputBox.onMouseMove = this.onComposerMouseMove
    this.inputBox.onMouseOut = this.onComposerMouseOut
    renderer.root.onMouseDrag = this.onRootMouseDrag
    renderer.root.onMouseUp = this.onRootMouseUp
    renderer.root.onMouseDragEnd = this.onRootMouseUp
    this.changedFilesBox.onMouseDown = this.onSidebarMouseDown
    this.changedFilesBox.onMouseOver = this.onSidebarMouseMove
    this.changedFilesBox.onMouseMove = this.onSidebarMouseMove
    this.changedFilesBox.onMouseOut = this.onSidebarMouseOut
    this.inputBox.add(this.input)
    this.inputBox.add(this.composerEditor)
    this.paletteBox.add(this.palette)
    this.paletteBox.add(this.overlayEditor)
    this.transcriptRow.add(this.transcriptScroll)
    this.transcriptRow.add(this.transcriptScrollbar)
    this.contentColumn.add(this.transcriptRow)
    this.contentColumn.add(this.queueBox)
    this.contentColumn.add(this.inputBox)
    this.contentColumn.add(this.queueLeftJoint)
    this.contentColumn.add(this.queueRightJoint)
    this.main.add(this.sidebar)
    this.main.add(this.contentColumn)
    this.main.add(this.changedFilesBox)
    renderer.root.add(this.main)
    renderer.root.add(this.modeLabel)
    renderer.root.add(this.statusLabel)
    renderer.root.add(this.workspaceLabel)
    renderer.root.add(this.paletteBox)
    renderer.root.add(this.toastBox)
    this.paletteBox.onMouseScroll = (event) => {
      if (this.model?.threadSwitcher.open !== true || event.scroll === undefined) return
      event.stopPropagation()
      this.handlers.threadPreviewScroll?.(event.scroll.direction === "up" ? 3 : -3)
    }
    renderer.keyInput.on("keypress", this.onKey)
    renderer.keyInput.on("paste", this.onPaste)
    renderer.on(CliRenderEvents.RESIZE, this.onResize)
    renderer.on(CliRenderEvents.SELECTION, this.onSelection)
  }

  private readonly onKey = (key: KeyEvent) => {
    const mapped = fromOpenTui(key)
    if (this.suppressMouseJunk(mapped)) return
    this.wakeCursor()
    if (!mapped.ctrl && !mapped.alt && !mapped.meta && mapped.name === "pageup") {
      this.userScrollDetached = true
      this.transcriptScroll.stickyScroll = false
      const amount = Math.max(1, this.transcriptScroll.viewport.height - 1)
      if (this.queuePendingTranscriptScroll(-amount)) return
      if (this.transcriptScroll.scrollTop <= 1 && this.shiftTranscriptWindow(-100, true, -amount)) return
      this.transcriptScroll.scrollBy(-amount)
      this.reportTranscriptScroll()
    } else if (!mapped.ctrl && !mapped.alt && !mapped.meta && mapped.name === "pagedown") {
      this.transcriptScroll.stickyScroll = false
      const amount = Math.max(1, this.transcriptScroll.viewport.height - 1)
      if (this.queuePendingTranscriptScroll(amount)) return
      if (this.atMountedTranscriptBottom() && this.shiftTranscriptWindow(100, true, amount)) return
      this.transcriptScroll.scrollBy(amount)
      this.reportTranscriptScroll()
    } else if (!mapped.ctrl && !mapped.alt && !mapped.meta && mapped.name === "end") {
      this.userScrollDetached = false
      this.handlers.scrollFollow?.()
    } else if (mapped.ctrl && mapped.name === "v" && this.handlers.pasteImage !== undefined) this.handlers.pasteImage()
    else this.handlers.key(mapped)
  }
  private readonly atMountedTranscriptBottom = (): boolean =>
    this.transcriptScroll.scrollTop >=
    Math.max(0, this.transcriptScroll.scrollHeight - this.transcriptScroll.viewport.height) - 1
  private readonly atTranscriptBottom = (): boolean =>
    this.atMountedTranscriptBottom() && this.transcriptWindowEnd >= (this.model?.items.length ?? 0)
  private readonly transcriptWindowStart = (): number =>
    Math.max(0, this.transcriptWindowEnd - maxMountedTranscriptEntries)
  private captureTranscriptAnchor(): TranscriptAnchor | undefined {
    const viewportTop = this.transcriptScroll.screenY
    const first = [...this.transcriptRecords.values()]
      .filter(({ renderable }) => renderable.height > 0 && renderable.screenY + renderable.height > viewportTop)
      .toSorted((left, right) => left.renderable.screenY - right.renderable.screenY)[0]
    return first === undefined ? undefined : { key: first.key, screenY: first.renderable.screenY }
  }
  private handleTranscriptScroll(): void {
    if (
      this.transcriptScroll.scrollTop <= 1 &&
      this.transcriptWindowStart() > 0 &&
      this.shiftTranscriptWindow(-100, true)
    )
      return
    this.reportTranscriptScroll()
  }
  private handleTranscriptWheel(event: MouseEvent): void {
    const direction = event.scroll?.direction
    if (direction !== "up" && direction !== "down") return
    this.wheelDirection = direction
    if (direction === "up") {
      const detach = !this.userScrollDetached && this.model?.scrollFollow === true
      this.userScrollDetached = true
      this.transcriptScroll.stickyScroll = false
      if (detach) this.handlers.scroll?.(this.transcriptScroll.scrollTop)
    } else if (this.atTranscriptBottom()) {
      this.cancelWheelReport()
      this.userScrollDetached = false
      this.handlers.scrollFollow?.()
      return
    } else if (this.atMountedTranscriptBottom()) this.wheelScrollBy += event.scroll?.delta ?? 1
    if (this.wheelTimer === undefined)
      this.wheelTimer = this.clock.setTimeout(() => {
        this.wheelTimer = undefined
        const pendingDirection = this.wheelDirection
        const scrollBy = this.wheelScrollBy
        this.wheelDirection = undefined
        this.wheelScrollBy = 0
        if (
          pendingDirection === "down" &&
          this.atMountedTranscriptBottom() &&
          this.shiftTranscriptWindow(100, true, scrollBy)
        )
          return
        this.handleTranscriptScroll()
      }, 16)
  }
  private cancelWheelReport(): void {
    if (this.wheelTimer === undefined) return
    this.clock.clearTimeout(this.wheelTimer)
    this.wheelTimer = undefined
    this.wheelDirection = undefined
    this.wheelScrollBy = 0
  }
  private shiftTranscriptWindow(delta: number, preserveAnchor: boolean, scrollBy = 0): boolean {
    const model = this.model
    if (model === undefined) return false
    const minimumEnd = Math.min(maxMountedTranscriptEntries, model.items.length)
    const end = Math.min(model.items.length, Math.max(minimumEnd, this.transcriptWindowEnd + delta))
    if (end === this.transcriptWindowEnd) return false
    this.transcriptWindowEnd = end
    this.transcriptRenderInput = undefined
    this.transcriptAnchorScrollBy = scrollBy
    this.update(model, preserveAnchor)
    return true
  }
  private queuePendingTranscriptScroll(scrollBy: number): boolean {
    const pending = this.pendingTranscriptAnchor
    if (pending === undefined || pending.threadId !== this.model?.currentThreadId) return false
    this.pendingTranscriptAnchor = { ...pending, scrollBy: pending.scrollBy + scrollBy }
    this.renderer.requestRender()
    return true
  }
  private readonly reportTranscriptScroll = () => {
    if (this.scrollProgrammatic || this.destroyed) return
    this.syncTranscriptScrollbar()
    if (this.atTranscriptBottom()) {
      this.userScrollDetached = false
      this.handlers.scrollFollow?.()
    } else this.handlers.scroll?.(this.transcriptScroll.scrollTop)
  }
  private syncTranscriptScrollbar(): void {
    if (this.destroyed) return
    const viewportHeight = this.transcriptViewportRows
    const scrollHeight = this.transcriptScroll.scrollHeight
    const overflowing = viewportHeight > 0 && scrollHeight > viewportHeight
    this.transcriptScrollbar.scrollSize = scrollHeight
    this.transcriptScrollbar.viewportSize = Math.max(1, viewportHeight)
    this.scrollbarSyncing = true
    this.transcriptScrollbar.scrollPosition = this.transcriptScroll.scrollTop
    this.scrollbarSyncing = false
    if (this.transcriptScrollbar.visible !== overflowing) this.transcriptScrollbar.visible = overflowing
  }
  private queueTranscriptScroll(action: () => void): void {
    const generation = this.scrollGeneration
    this.defer(() => {
      if (this.destroyed || generation !== this.scrollGeneration) return
      action()
    })
  }
  private anchorTranscriptAfterLayout(): void {
    this.defer(() => {
      if (this.model === undefined) return
      this.syncTranscriptScrollbar()
    })
  }
  private followTranscriptAfterLayout(): void {
    if (this.scrollFramePending) return
    this.scrollFramePending = true
    this.defer(() => {
      this.scrollFramePending = false
      if (this.model?.scrollFollow !== true || this.userScrollDetached) return
      this.scrollProgrammatic = true
      this.transcriptScroll.scrollTo(
        Math.max(0, this.transcriptScroll.scrollHeight - this.transcriptScroll.viewport.height),
      )
      this.scrollProgrammatic = false
      this.syncTranscriptScrollbar()
      this.renderer.requestRender()
    })
  }
  private junkBuffer: Array<Key> = []
  private junkTimer: Fiber.Fiber<void> | undefined

  private cancelTimer(timer: Fiber.Fiber<void> | undefined): void {
    timer?.interruptUnsafe()
  }

  private defer(action: () => void): void {
    Effect.runFork(Effect.yieldNow.pipe(Effect.andThen(Effect.sync(action))))
  }

  private delayed(duration: number, action: () => void): Fiber.Fiber<void> {
    return Effect.runFork(Effect.sleep(duration).pipe(Effect.andThen(Effect.sync(action))))
  }

  private repeated(duration: number, action: () => void): Fiber.Fiber<void> {
    return Effect.runFork(
      Effect.sleep(duration).pipe(
        Effect.andThen(Effect.sync(action)),
        Effect.repeat(Schedule.spaced(duration)),
        Effect.asVoid,
      ),
    )
  }

  private tickLoader(): void {
    this.loaderPhase += 1
    this.toolSpinner.step()
    const current = this.model
    if (current !== undefined) {
      const label = formatActivity(current.activity) ?? panelLoading(current)
      if (label !== undefined)
        this.statusLabel.content = new StyledText([
          fg(colors.text)(" "),
          fg(colors.blue)(loaderFrame(label, this.loaderPhase)),
          dim(fg(colors.text)(` ${label} `)),
        ])
      const glyph = this.toolSpinner.toBraille()
      for (const record of this.transcriptRecords.values()) {
        if (record.spinnerChunk === undefined) continue
        const content = record.renderable.content
        const chunks = [...content.chunks]
        const chunk = chunks[record.spinnerChunk]
        if (chunk === undefined) continue
        chunks[record.spinnerChunk] = { ...chunk, text: glyph }
        const next = new StyledText(chunks)
        record.revision = JSON.stringify(next.chunks)
        record.renderable.content = next
      }
      if (current.threadSidebar.open)
        this.sidebar.content = renderSidebar(current, spinnerFrames[this.loaderPhase % spinnerFrames.length]!)
    }
    this.renderer.requestRender()
  }

  private readonly flushJunkBuffer = () => {
    this.cancelTimer(this.junkTimer)
    this.junkTimer = undefined
    const pending = this.junkBuffer
    this.junkBuffer = []
    for (const buffered of pending) this.handlers.key(buffered)
  }

  private readonly armJunkBuffer = (mapped: Key) => {
    this.cancelTimer(this.junkTimer)
    this.junkBuffer = [mapped]
    this.junkTimer = this.delayed(40, this.flushJunkBuffer)
  }

  private readonly suppressMouseJunk = (mapped: Key): boolean => {
    if (mapped.ctrl || mapped.alt || mapped.meta || mapped.eventType === "release") return false
    if (mapped.sequence.length > 1 && mouseSequencePattern.test(mapped.sequence)) return true
    if (this.junkBuffer.length > 0) {
      if (/^[\d;]$/.test(mapped.sequence) && this.junkBuffer.length < 24) {
        this.junkBuffer.push(mapped)
        this.cancelTimer(this.junkTimer)
        this.junkTimer = this.delayed(40, this.flushJunkBuffer)
        return true
      }
      if (mapped.sequence === "M" || mapped.sequence === "m") {
        this.cancelTimer(this.junkTimer)
        this.junkTimer = undefined
        this.junkBuffer = []
        return true
      }
      if (mapped.sequence === "<") {
        this.armJunkBuffer(mapped)
        return true
      }
      this.flushJunkBuffer()
      return false
    }
    if (mapped.sequence === "<") {
      this.armJunkBuffer(mapped)
      return true
    }
    return false
  }

  private readonly onPaste = (event: PasteEvent) => {
    const mediaType = event.metadata?.mimeType?.toLowerCase()
    if (event.metadata?.kind === "binary" || mediaType?.startsWith("image/") === true) {
      if (event.bytes.length > 0) {
        this.wakeCursor()
        this.handlers.pasteImage?.(mediaType === undefined ? { bytes: event.bytes } : { bytes: event.bytes, mediaType })
      }
      return
    }
    const text = stripAnsiSequences(decodePasteBytes(event.bytes))
    if (text.length === 0) return
    this.wakeCursor()
    const now = Effect.runSync(Clock.currentTimeMillis)
    const attachment = this.model?.pastedText.findLast(
      (candidate) => candidate.type === "text" && candidate.value === text,
    )
    if (this.lastPaste?.text === text && now - this.lastPaste.at < 500 && attachment !== undefined) {
      this.handlers.expandPaste?.(attachment.token)
      this.lastPaste = undefined
      return
    }
    this.lastPaste = { text, at: now }
    this.handlers.paste?.(text)
  }
  private readonly physicalTerminalSize = (width: number, height: number) => {
    if ((this.renderer as unknown as { readonly _usesProcessStdout?: boolean })._usesProcessStdout !== true)
      return { width, height }
    const stream = (this.renderer as unknown as { readonly stdout?: NodeJS.WriteStream }).stdout
    const physicalWidth = stream?.columns
    const physicalHeight = stream?.rows
    const currentWidth =
      Number.isInteger(physicalWidth) && physicalWidth !== undefined && physicalWidth > 0 ? physicalWidth : width
    const currentHeight =
      Number.isInteger(physicalHeight) && physicalHeight !== undefined && physicalHeight > 0 ? physicalHeight : height
    return { width: currentWidth, height: currentHeight }
  }
  private readonly onResize = (width: number, height: number) => {
    const current = this.physicalTerminalSize(width, height)
    if (
      (current.width !== width || current.height !== height) &&
      (this.renderer.terminalWidth !== current.width || this.renderer.terminalHeight !== current.height)
    )
      this.renderer.resize(current.width, current.height)
    this.handlers.resize(current.width, current.height)
  }
  private readonly setPointerShape = (shape: "ns-resize" | "ew-resize" | "default") => {
    if (this.pointerShape === shape) return
    this.pointerShape = shape
    const renderer = this.renderer as unknown as {
      stdout?: NodeJS.WriteStream
      realStdoutWrite?: NodeJS.WriteStream["write"]
    }
    if (renderer.stdout !== undefined && renderer.realStdoutWrite !== undefined) {
      renderer.realStdoutWrite.call(renderer.stdout, `\u001b]22;${shape}\u001b\\`)
      return
    }
    this.renderer.setMousePointer(shape === "default" ? "default" : "move")
  }
  private readonly setComposerResizePointer = (active: boolean) => {
    this.setPointerShape(active ? "ns-resize" : "default")
  }
  private readonly setSidebarResizePointer = (active: boolean) => {
    this.setPointerShape(active ? "ew-resize" : "default")
  }
  private readonly onSidebarMouseMove = (event: MouseEvent) => {
    if (this.sidebarDrag === undefined) this.setSidebarResizePointer(event.x === this.changedFilesBox.x)
  }
  private readonly onSidebarMouseOut = () => {
    if (this.sidebarDrag === undefined) this.setSidebarResizePointer(false)
  }
  private readonly onSidebarMouseDown = (event: MouseEvent) => {
    if (event.button !== 0 || this.model === undefined) return
    if (event.x !== this.changedFilesBox.x) return
    this.sidebarDrag = { startX: event.x, startWidth: this.model.sidebarWidth }
    this.setSidebarResizePointer(true)
    event.preventDefault()
    event.stopPropagation()
  }
  private readonly onRootMouseDrag = (event: MouseEvent) => {
    if (this.sidebarDrag !== undefined) {
      this.handlers.sidebarResize?.(this.sidebarDrag.startWidth + (this.sidebarDrag.startX - event.x))
      event.preventDefault()
      event.stopPropagation()
      return
    }
    this.onComposerMouseDrag(event)
  }
  private readonly onRootMouseUp = (event: MouseEvent) => {
    if (this.sidebarDrag !== undefined) {
      this.sidebarDrag = undefined
      this.sidebarRowsWidth = 0
      if (this.model !== undefined) this.refreshSidebarRows(this.model)
      this.setSidebarResizePointer(event.x === this.changedFilesBox.x)
      event.preventDefault()
      event.stopPropagation()
      return
    }
    this.onComposerMouseUp(event)
  }
  private readonly onComposerMouseMove = (event: MouseEvent) => {
    this.setComposerResizePointer(this.model?.shortcutsOpen !== true && event.y === this.inputBox.y)
  }
  private readonly onComposerMouseOut = () => {
    if (this.composerDrag === undefined) this.setComposerResizePointer(false)
  }
  private readonly onComposerMouseDown = (event: MouseEvent) => {
    const model = this.model
    if (event.button !== 0 || model === undefined || model.shortcutsOpen) return
    if (event.y !== this.inputBox.y) {
      const row = event.y - this.composerEditor.y
      const column = event.x - this.composerEditor.x
      const token = pastedTextTokenAt(model, row * Math.max(1, this.composerEditor.width) + column)
      if (token !== undefined) this.handlers.expandPaste?.(token)
      return
    }
    this.composerDrag = { startY: event.y, startHeight: this.inputBox.height }
    this.setComposerResizePointer(true)
    event.preventDefault()
    event.stopPropagation()
  }
  private readonly onComposerMouseDrag = (event: MouseEvent) => {
    if (this.composerDrag === undefined) return
    this.handlers.composerResize?.(this.composerDrag.startHeight - (event.y - this.composerDrag.startY))
    event.preventDefault()
    event.stopPropagation()
  }
  private readonly onComposerMouseUp = (event: MouseEvent) => {
    if (this.composerDrag === undefined) return
    this.composerDrag = undefined
    this.setComposerResizePointer(event.y === this.inputBox.y)
    event.preventDefault()
    event.stopPropagation()
  }
  private clearTranscriptChildren(): void {
    this.welcomeChild = undefined
    for (const child of this.transcriptChildren) {
      this.transcriptContent.remove(child)
      child.destroy()
    }
    this.transcriptChildren = []
    this.transcriptRecords.clear()
    this.transcriptRenderInput = undefined
  }
  private setWelcomeChild(child: TextRenderable): void {
    this.clearTranscriptChildren()
    this.transcriptChildren = [child]
    this.transcriptContent.add(child)
  }
  private reconcileTranscript(descriptors: ReadonlyArray<TranscriptRenderableDescriptor>): void {
    if (this.welcomeChild !== undefined) this.clearTranscriptChildren()
    const desiredKeys = new Set(descriptors.map((descriptor) => descriptor.key))
    const selection = this.renderer.getSelection()
    const selected = new Set(selection?.touchedRenderables ?? [])
    const pinned = [...this.transcriptRecords.values()].filter(
      (record) => !desiredKeys.has(record.key) && selected.has(record.renderable),
    )
    for (const record of this.transcriptRecords.values()) {
      if (desiredKeys.has(record.key) || selected.has(record.renderable)) continue
      this.transcriptContent.remove(record.renderable)
      record.renderable.destroy()
      this.transcriptRecords.delete(record.key)
    }
    const desired = descriptors.map((descriptor) => {
      const handleMouseDown = (renderable: TextRenderable, event: MouseEvent) => {
        if (event.button === 0) {
          const row = event.y - renderable.screenY
          const column = event.x - renderable.screenX
          const text = descriptor.content.chunks
            .map((chunk) => chunk.text)
            .join("")
            .split("\n")[row]
          if (text !== undefined)
            for (const target of descriptor.targets ?? []) {
              const label = escapePathTarget(target.path)
              let offset = text.indexOf(label)
              while (offset >= 0) {
                const start = stringWidth(text.slice(0, offset))
                const end = start + stringWidth(label)
                if (column >= start && column < end) {
                  event.stopPropagation()
                  this.handlers.openPath?.(target)
                  return
                }
                offset = text.indexOf(label, offset + label.length)
              }
            }
        }
        descriptor.onMouseDown?.(event)
      }
      const existing = this.transcriptRecords.get(descriptor.key)
      if (existing !== undefined) {
        if (existing.revision !== descriptor.revision) {
          existing.revision = descriptor.revision
          existing.renderable.content = descriptor.content
        }
        if (descriptor.spinnerChunk === undefined) delete existing.spinnerChunk
        else existing.spinnerChunk = descriptor.spinnerChunk
        existing.renderable.selectable = descriptor.selectable ?? true
        existing.renderable.onMouseDown = (event) => handleMouseDown(existing.renderable, event)
        return existing
      }
      const renderable = new TextRenderable(this.renderer, {
        content: descriptor.content,
        wrapMode: "word",
        selectable: descriptor.selectable ?? true,
      })
      renderable.onMouseDown = (event) => handleMouseDown(renderable, event)
      const record = {
        key: descriptor.key,
        revision: descriptor.revision,
        renderable,
        ...(descriptor.spinnerChunk === undefined ? {} : { spinnerChunk: descriptor.spinnerChunk }),
      }
      this.transcriptRecords.set(record.key, record)
      return record
    })
    const records = [...pinned, ...desired]
    const children = records.map((record) => record.renderable)
    const current = [...this.transcriptContent.getChildren()]
    children.forEach((child, index) => {
      if (current[index] === child) return
      const previous = current.indexOf(child)
      if (previous >= 0) current.splice(previous, 1)
      current.splice(index, 0, child)
      this.transcriptContent.add(child, index)
    })
    this.transcriptChildren = children
  }
  private transcriptChanged(input: TranscriptRenderInput): boolean {
    const previous = this.transcriptRenderInput
    return (
      previous === undefined ||
      previous.entries !== input.entries ||
      previous.blocks !== input.blocks ||
      previous.items !== input.items ||
      previous.expandedRowKeys !== input.expandedRowKeys ||
      previous.detailSelection !== input.detailSelection ||
      previous.permissionSelection !== input.permissionSelection ||
      previous.width !== input.width ||
      previous.windowEnd !== input.windowEnd
    )
  }
  private refreshSidebarRows(model: Model): void {
    const view = model.changedFilesOpen ? "changed" : "workspace"
    const source = view === "changed" ? model.changedFiles : model.filePicker.items
    const width = sidebarInnerWidth(model)
    if (
      this.sidebarRowsView !== view ||
      this.sidebarRowsSource !== source ||
      (this.sidebarDrag === undefined && this.sidebarRowsWidth !== width)
    ) {
      this.sidebarRowsView = view
      this.sidebarRowsSource = source
      this.sidebarRowsWidth = width
      this.changedRows = sidebarFileRows(model, width)
      this.changedFilesBox.setVirtualHeight(this.changedRows.length)
      this.sidebarWindowStart = -1
      this.sidebarWindowEnd = -1
    }
    this.refreshSidebarWindow()
  }
  private refreshSidebarWindow(force = false): boolean {
    if (!this.changedFilesBox.visible) return false
    const viewportRows = Math.max(1, this.changedFilesBox.viewport.height || (this.model?.height ?? 1) - 2)
    const scrollTop = Math.min(
      Math.max(0, Math.floor(this.changedFilesBox.scrollTop)),
      Math.max(0, this.changedRows.length - viewportRows),
    )
    const start = scrollTop
    const end = Math.min(this.changedRows.length, scrollTop + viewportRows)
    if (
      !force &&
      start === this.sidebarWindowStart &&
      end === this.sidebarWindowEnd &&
      this.changedFilesHoveredRow === this.sidebarWindowHoveredRow
    )
      return false
    this.sidebarWindowStart = start
    this.sidebarWindowEnd = end
    this.sidebarWindowHoveredRow = this.changedFilesHoveredRow
    this.changedFilesText.content = renderFileRows(
      this.changedRows.slice(start, end),
      this.changedFilesHoveredRow === undefined ? undefined : this.changedFilesHoveredRow - start,
    )
    return true
  }
  private refreshSidebarAfterLayout(): void {
    if (this.sidebarLayoutFrame !== undefined) return
    const refresh = () => {
      this.renderer.off(CliRenderEvents.FRAME, refresh)
      this.sidebarLayoutFrame = undefined
      if (this.destroyed) return
      this.changedFilesBox.syncVirtualScroll()
      if (this.refreshSidebarWindow()) this.renderer.requestRender()
    }
    this.sidebarLayoutFrame = refresh
    this.renderer.on(CliRenderEvents.FRAME, refresh)
  }
  private welcomeWidthFor(model: Model): number {
    return Math.max(1, contentColumnWidth(model) - spacing.transcript * 2)
  }
  showToast(message: string, color: ColorInput = colors.green): void {
    const terminalWidth = Math.max(1, this.model?.width ?? this.renderer.width)
    const right = Math.min(2, Math.max(0, terminalWidth - 1))
    const width = Math.max(1, Math.min(stringWidth(message) + 6, terminalWidth - right))
    const visibleMessage = truncateToWidth(message, Math.max(0, width - 6))
    this.toast.content = new StyledText([fg(color)("✓ "), fg(colors.text)(visibleMessage)])
    this.toastBox.borderColor = color
    this.toastBox.right = right
    this.toastBox.width = width
    this.toastBox.visible = true
    this.renderer.requestRender()
    this.cancelTimer(this.toastTimer)
    this.toastTimer = this.delayed(2500, () => {
      this.toastBox.visible = false
      this.toastTimer = undefined
      this.renderer.requestRender()
    })
  }
  private readonly onSelection = (selection: { getSelectedText: () => string }) => {
    const text = selection.getSelectedText().trimEnd()
    if (text.length === 0) return
    this.renderer.copyToClipboardOSC52(text)
    this.showToast("Selection copied to clipboard")
  }

  update(model: Model, preserveTranscriptAnchor = false): void {
    const previousScrollHeight = this.transcriptScroll.scrollHeight
    const previousModel = this.model
    if (
      previousModel?.currentThreadId !== model.currentThreadId ||
      (previousModel?.scrollFollow === false && model.scrollFollow)
    )
      this.userScrollDetached = false
    const scrollFollow = model.scrollFollow && !this.userScrollDetached
    const transcriptWidthChanged =
      previousModel !== undefined &&
      previousModel.currentThreadId === model.currentThreadId &&
      !scrollFollow &&
      (model.entries.length > 0 || model.blocks.length > 0) &&
      contentColumnWidth(previousModel) !== contentColumnWidth(model)
    const preserveTranscriptPosition = preserveTranscriptAnchor || transcriptWidthChanged
    const transcriptAnchor = preserveTranscriptPosition ? this.captureTranscriptAnchor() : undefined
    const previousItems = previousModel?.items.length ?? 0
    if (this.transcriptWindowThread !== model.currentThreadId) {
      if (this.transcriptAnchorFrame !== undefined) this.renderer.off(CliRenderEvents.FRAME, this.transcriptAnchorFrame)
      this.transcriptAnchorFrame = undefined
      this.pendingTranscriptAnchor = undefined
      this.transcriptAnchorScrollBy = 0
      this.transcriptWindowThread = model.currentThreadId
      this.transcriptWindowEnd = model.items.length
    } else if (preserveTranscriptPosition)
      this.transcriptWindowEnd = Math.min(
        model.items.length,
        this.transcriptWindowEnd + Math.max(0, model.items.length - previousItems),
      )
    else if (scrollFollow || this.transcriptWindowEnd === 0) this.transcriptWindowEnd = model.items.length
    else this.transcriptWindowEnd = Math.min(this.transcriptWindowEnd, model.items.length)
    this.model = model
    this.queueHint.bg = cutoutBackground(this.renderer)
    this.modeLabel.bg = cutoutBackground(this.renderer)
    this.workspaceLabel.bg = cutoutBackground(this.renderer)
    this.statusLabel.bg = cutoutBackground(this.renderer)
    if (model.shortcutsOpen) this.setComposerResizePointer(false)
    const inputHeight = composerHeight(model)
    const renderedInputHeight = model.shortcutsOpen
      ? Math.min(Math.max(1, model.height - 4), spacing.inputHeight + 12)
      : model.queue.length > 0
        ? Math.min(inputHeight, Math.max(1, model.height - 2))
        : inputHeight
    this.inputBox.minHeight = Math.min(spacing.inputHeight, renderedInputHeight)
    const sidebarWidth = fileSidebarLayoutWidth(model)
    const sidebarVisible = sidebarWidth > 0
    const contentLeft = threadSidebarLayoutWidth(model)
    const threadSidebarVisible = contentLeft > 0
    const contentWidth = contentColumnWidth(model)
    const modeColor = colors[model.mode]
    const isWelcome = model.entries.length === 0 && model.blocks.length === 0
    this.transcriptScroll.content.justifyContent = isWelcome ? "flex-start" : "flex-end"
    const animateWelcome =
      isWelcome &&
      !model.threadSwitcher.open &&
      !model.filePicker.open &&
      !model.modePicker.open &&
      !model.palette.open &&
      !model.paletteOpen
    if (isWelcome) {
      this.transcriptRenderInput = undefined
      const welcomeWidth = this.welcomeWidthFor(model)
      const welcomeKey = `${welcomeWidth}:${model.height}:${this.welcomePhase}:${model.mode}`
      const existingWelcome = this.transcriptChildren.length === 1 ? this.welcomeChild : undefined
      if (existingWelcome === undefined) {
        const child = new TextRenderable(this.renderer, {
          content: welcomeContent(welcomeWidth, model.height, this.welcomePhase, model.mode),
          fg: modeColor,
          wrapMode: "word",
          selectable: true,
        })
        this.setWelcomeChild(child)
        this.welcomeChild = child
        this.welcomeKey = welcomeKey
      } else if (this.welcomeKey !== welcomeKey) {
        this.welcomeKey = welcomeKey
        existingWelcome.fg = modeColor
        existingWelcome.content = welcomeContent(welcomeWidth, model.height, this.welcomePhase, model.mode)
      }
    } else {
      const renderModel = sidebarWidth === 0 && !threadSidebarVisible ? model : { ...model, width: contentWidth }
      const transcriptInput = {
        entries: renderModel.entries,
        blocks: renderModel.blocks,
        items: renderModel.items,
        expandedRowKeys: renderModel.expandedRowKeys,
        detailSelection: renderModel.detailSelection,
        permissionSelection: renderModel.permissionSelection,
        width: renderModel.width,
        windowEnd: this.transcriptWindowEnd,
      }
      if (this.transcriptChanged(transcriptInput)) {
        const toolSpinnerGlyph = this.toolSpinner.toBraille()
        const built = buildTranscript(boundedTranscriptModel(renderModel, this.transcriptWindowEnd), toolSpinnerGlyph)
        const styledLines = splitStyledLines(built.styled)
        const descriptors: Array<TranscriptRenderableDescriptor> = []
        for (const range of built.ranges.slice(-maxMountedTranscriptEntries)) {
          if (range.gapBefore === true)
            descriptors.push({
              key: `${range.unit}:gap`,
              revision: "gap",
              content: new StyledText([fg(colors.text)(" ")]),
            })
          const headerContent = new StyledText(styledLines[range.start] ?? [])
          const spinnerChunk =
            range.animated === true ? headerContent.chunks.findIndex((chunk) => chunk.text === toolSpinnerGlyph) : -1
          descriptors.push({
            key: `${range.unit}:header`,
            revision: JSON.stringify(headerContent.chunks),
            content: headerContent,
            selectable: !range.expandable,
            ...(range.targets === undefined ? {} : { targets: range.targets }),
            ...(spinnerChunk < 0 ? {} : { spinnerChunk }),
            ...(range.expandable
              ? {
                  onMouseDown: (event: MouseEvent) => {
                    if (event.button !== 0) return
                    event.stopPropagation()
                    this.handlers.clickToggle?.(range.unit)
                  },
                }
              : {}),
          })
          const body: Array<TextChunk> = []
          const bodyLines = styledLines.slice(range.start + 1, range.end + 1)
          for (const [index, line] of bodyLines.entries()) {
            body.push(...line)
            if (index < bodyLines.length - 1) body.push(fg(colors.text)("\n"))
          }
          if (body.length > 0)
            descriptors.push({
              key: `${range.unit}:body`,
              revision: JSON.stringify(body),
              content: new StyledText(body),
              ...(range.targets === undefined ? {} : { targets: range.targets }),
            })
        }
        this.reconcileTranscript(descriptors)
        this.transcriptRenderInput = transcriptInput
      }
    }
    if (this.options.animate !== false && animateWelcome && this.welcomeTimer === undefined) {
      this.welcomeTimer = this.repeated(80, () => {
        const current = this.model
        if (current === undefined || current.entries.length > 0 || current.blocks.length > 0) return
        this.welcomePhase = (this.welcomePhase + 1) % welcomeMarkFrames.length
        const welcome = this.welcomeChild
        if (welcome === undefined) return
        const width = this.welcomeWidthFor(current)
        this.welcomeKey = `${width}:${current.height}:${this.welcomePhase}:${current.mode}`
        welcome.content = welcomeContent(width, current.height, this.welcomePhase, current.mode)
        this.renderer.requestRender()
      })
    } else if ((this.options.animate === false || !animateWelcome) && this.welcomeTimer !== undefined) {
      this.cancelTimer(this.welcomeTimer)
      this.welcomeTimer = undefined
    }
    const queue = model.queue as ReadonlyArray<QueueItem>
    this.queueBox.marginLeft = contentWidth <= 4 ? 0 : 1
    this.queueBox.marginRight = contentWidth <= 4 ? 0 : 1
    this.queueBox.visible = queue.length > 0
    const queueTextWidth = queueContentWidth(model)
    const queueLength = queue.length
    const selectedIndex = queue.findIndex((item) => item.id === model.queueSelection)
    const editIndex = queue.findIndex((item) => item.id === model.editingTurnId)
    const hintIndex = editIndex >= 0 ? editIndex : selectedIndex
    const editing = model.editingTurnId !== undefined && editIndex >= 0
    const hintSegments =
      hintIndex < 0 ? [] : fittingQueueHint(editing ? queueEditingHint : queueNavigationHint, queueTextWidth)
    const hintWidth = queueHintWidth(hintSegments)
    const labels = queue.map((item, index) => {
      const label = queueItemLabel(item)
      if (index !== hintIndex || hintSegments.length === 0) return label
      const [first = "", ...remaining] = label.split("\n")
      const width = queueTextWidth - hintWidth
      const inline = stringWidth(first) <= width ? first : `${truncateToWidth(first, Math.max(1, width - 1))}…`
      return [inline, ...remaining].join("\n")
    })
    const heights = labels.map((label) => wrappedRowCount(label, queueTextWidth))
    const queueRows = heights.reduce((sum, rows) => sum + rows, 0)
    const queueBoxHeight = Math.min(
      Math.max(1, model.height),
      Math.min(Math.max(3, model.height - renderedInputHeight - 2), Math.max(3, queueRows + 2)),
    )
    this.queueBox.minHeight = Math.min(3, queueBoxHeight)
    this.queueBox.height = queueBoxHeight
    const availableRows = Math.max(1, queueBoxHeight - 2)
    const clampToRows = (text: string, rows: number): string =>
      wrappedRowCount(text, queueTextWidth) <= rows
        ? text
        : `${truncateToWidth(text.replace(/\n/g, " "), Math.max(1, rows * queueTextWidth - 1))}…`
    const focusIndex = hintIndex < 0 ? queueLength - 1 : hintIndex
    let start = focusIndex
    let end = focusIndex + 1
    let used = Math.min(availableRows, heights[focusIndex] ?? 0)
    while (end < queueLength && used + heights[end]! <= availableRows) used += heights[end++]!
    while (start > 0 && used + heights[start - 1]! <= availableRows) used += heights[--start]!
    const queueChunks: Array<TextChunk> = []
    let hintTop = 0
    let renderedRows = 0
    for (const [offset, item] of queue.slice(start, end).entries()) {
      const index = start + offset
      const label = clampToRows(labels[index]!, availableRows)
      const labelRows = wrappedRowCount(label, queueTextWidth)
      if (index === hintIndex && hintSegments.length > 0) hintTop = renderedRows
      queueChunks.push(item.id === model.queueSelection ? bold(fg(colors.text)(label)) : fg(colors.subtle)(label))
      renderedRows += labelRows
      if (index < end - 1) queueChunks.push(fg(colors.text)("\n"))
    }
    this.queueText.content = new StyledText(queueChunks)
    this.queueHint.top = hintTop
    const hintChunks: Array<TextChunk> = []
    for (const [index, segment] of hintSegments.entries()) {
      hintChunks.push(dim(fg(colors.text)(index === 0 ? " " : " · ")))
      hintChunks.push(fg(colors[model.mode])(segment.accent))
      if (segment.suffix.length > 0) hintChunks.push(dim(fg(colors.text)(segment.suffix)))
    }
    if (hintSegments.length > 0) hintChunks.push(dim(fg(colors.text)(" ")))
    this.queueHint.content = new StyledText(hintChunks)
    this.queueHint.visible = hintSegments.length > 0
    this.queueLeftJoint.visible = queue.length > 0
    this.queueRightJoint.visible = queue.length > 0
    this.inputBox.borderColor = colors.text
    const costText = model.costUsd !== undefined ? formatCost(model.costUsd) : model.busy ? "$····" : ""
    this.inputBox.title = ""
    const modeChunks: Array<TextChunk> = []
    if (costText.length > 0) {
      modeChunks.push(dim(fg(colors.text)(` ${costText} `)))
      modeChunks.push(fg(colors.text)("─"))
    }
    modeChunks.push(fg(colors.text)(" "))
    if (model.fastMode) modeChunks.push(fg(colors.amber)("↯"))
    modeChunks.push(fg(colors[model.mode])(model.mode))
    modeChunks.push(fg(colors.text)(" "))
    this.modeLabel.right = sidebarWidth + 2
    this.modeLabel.width = modeChunks.reduce((total, chunk) => total + stringWidth(chunk.text), 0)
    this.modeLabel.content = new StyledText(modeChunks)
    const workspaceTitle = isNarrow(model)
      ? ""
      : ` ${compactWorkspace(model.workspace)}${model.branch === undefined ? "" : ` (${model.branch})`} `
    const panelLoadingLabel = panelLoading(model)
    const activityLabel = formatActivity(model.activity)
    if (activityLabel !== undefined || panelLoadingLabel !== undefined) {
      const statusName = activityLabel ?? panelLoadingLabel!
      this.inputBox.bottomTitle = ""
      this.statusLabel.content = new StyledText([
        fg(colors.text)(" "),
        fg(colors.blue)(loaderFrame(statusName, this.loaderPhase)),
        dim(fg(colors.text)(` ${statusName} `)),
      ])
    } else {
      this.inputBox.bottomTitle = ""
      this.statusLabel.content = ""
    }
    this.workspaceLabel.right = sidebarWidth + 2
    this.workspaceLabel.content = new StyledText([dim(fg(colors.text)(workspaceTitle))])
    this.inputBox.height = renderedInputHeight
    const queueHeight = queue.length > 0 ? this.queueBox.height - 1 : 0
    this.modeLabel.top = model.height - renderedInputHeight
    this.queueLeftJoint.top = model.height - renderedInputHeight
    this.queueRightJoint.top = model.height - renderedInputHeight
    this.transcriptViewportRows = Math.max(1, model.height - renderedInputHeight - queueHeight)
    this.transcriptScroll.content.minHeight = this.transcriptViewportRows
    this.input.visible = model.shortcutsOpen
    this.input.content = model.shortcutsOpen ? shortcutsContent(model, Math.max(1, contentWidth - 4)) : ""
    this.composerEditor.visible = !model.shortcutsOpen
    this.composerEditor.height = Math.max(1, renderedInputHeight - 2)
    this.composerEditor.sync(displayInput(model), displayCursorOffset(model))
    this.sidebar.visible = threadSidebarVisible
    this.sidebar.width = boundedThreadSidebarWidth(model.width)
    this.sidebar.content = threadSidebarVisible
      ? renderSidebar(model, spinnerFrames[this.loaderPhase % spinnerFrames.length]!)
      : ""
    this.changedFilesBox.visible = sidebarVisible
    if (this.changedFilesBox.visible) {
      this.changedFilesBox.width = Math.max(1, sidebarWidth - 2)
      this.changedFilesBox.title = model.changedFilesOpen
        ? ` Changed files (${readyOr(model.changedFiles, []).length}) `
        : ` Files (${readyOr(model.filePicker.items, []).length}) `
      this.changedFilesBox.titleAlignment = "left"
      this.refreshSidebarRows(model)
      if (
        previousModel === undefined ||
        previousModel.width !== model.width ||
        previousModel.height !== model.height ||
        previousModel.sidebarWidth !== model.sidebarWidth ||
        previousModel.changedFilesOpen !== model.changedFilesOpen ||
        previousModel.changedFiles !== model.changedFiles ||
        previousModel.workspaceFilesOpen !== model.workspaceFilesOpen ||
        previousModel.filePicker.items !== model.filePicker.items
      )
        this.refreshSidebarAfterLayout()
    } else {
      this.changedFilesHoveredRow = undefined
    }
    this.transcriptScroll.stickyScroll = scrollFollow
    this.anchorTranscriptAfterLayout()
    if (preserveTranscriptPosition) {
      const pending = this.pendingTranscriptAnchor
      this.pendingTranscriptAnchor =
        pending !== undefined && pending.threadId === model.currentThreadId
          ? { ...pending, scrollBy: pending.scrollBy + this.transcriptAnchorScrollBy }
          : {
              anchor: transcriptAnchor,
              threadId: model.currentThreadId,
              scrollHeight: previousScrollHeight,
              scrollBy: this.transcriptAnchorScrollBy,
            }
      this.transcriptAnchorScrollBy = 0
      if (this.transcriptAnchorFrame === undefined) {
        const restore = () => {
          this.transcriptAnchorFrame = undefined
          const current = this.pendingTranscriptAnchor
          this.pendingTranscriptAnchor = undefined
          if (current === undefined || this.model?.currentThreadId !== current.threadId || this.destroyed) return
          const anchored = current.anchor === undefined ? undefined : this.transcriptRecords.get(current.anchor.key)
          const anchorScreenY = current.anchor?.screenY
          const offset =
            anchored === undefined || anchorScreenY === undefined
              ? this.transcriptScroll.scrollHeight - current.scrollHeight
              : anchored.renderable.screenY - anchorScreenY
          this.scrollProgrammatic = true
          this.transcriptScroll.scrollTop = this.transcriptScroll.scrollTop + offset
          if (current.scrollBy !== 0) this.transcriptScroll.scrollBy(current.scrollBy)
          this.scrollProgrammatic = false
          this.syncTranscriptScrollbar()
          if (current.scrollBy === 0) this.handlers.scrollGeometry?.(this.transcriptScroll.scrollTop)
          else this.reportTranscriptScroll()
          this.renderer.requestRender()
        }
        this.transcriptAnchorFrame = restore
        this.renderer.once(CliRenderEvents.FRAME, restore)
      }
    } else if (this.pendingTranscriptAnchor !== undefined) this.renderer.requestRender()
    else if (scrollFollow) this.followTranscriptAfterLayout()
    else if (this.wheelTimer === undefined && Math.abs(this.transcriptScroll.scrollTop - model.scrollOffset) > 1) {
      this.scrollProgrammatic = true
      this.transcriptScroll.scrollTop = model.scrollOffset
      this.scrollProgrammatic = false
    }
    const loaderActive =
      model.busy ||
      model.activity !== undefined ||
      panelLoadingLabel !== undefined ||
      (model.threadSidebar.open &&
        (model.threads as ReadonlyArray<ThreadItem>).some((thread) => thread.status !== "idle"))
    if (this.options.animate !== false && loaderActive && this.loaderTimer === undefined) {
      this.loaderTimer = this.clock.setInterval(() => this.tickLoader(), spinnerInterval)
    } else if ((this.options.animate === false || !loaderActive) && this.loaderTimer !== undefined) {
      this.clock.clearInterval(this.loaderTimer)
      this.loaderTimer = undefined
    }
    const composerTop = model.height - renderedInputHeight
    const overlay = model.threadSwitcher.open
      ? ("threads" as const)
      : model.filePicker.open
        ? ("files" as const)
        : model.modePicker.open
          ? ("modes" as const)
          : model.palette.open || model.paletteOpen
            ? ("palette" as const)
            : undefined
    this.paletteBox.visible = overlay !== undefined
    this.palette.visible = this.paletteBox.visible
    this.paletteBox.bottomTitle = ""
    let cursorEditor: ProjectedEditorRenderable | undefined =
      model.shortcutsOpen || (threadSidebarVisible && model.threadSidebar.focused) ? undefined : this.composerEditor
    if (overlay === "palette") {
      const results = filter(model.palette.query)
      const boxWidth = Math.max(1, Math.min(80, model.width - 4))
      const boxHeight = Math.min(Math.max(1, composerTop), results.length + 5)
      this.paletteBox.width = boxWidth
      this.paletteBox.height = boxHeight
      this.paletteBox.left = Math.max(0, Math.floor((model.width - boxWidth) / 2))
      this.paletteBox.top = Math.max(0, Math.floor((composerTop - boxHeight) / 2))
      this.paletteBox.title = " Command Palette "
      this.paletteBox.titleColor = colors.amber
      this.paletteBox.titleAlignment = "left"
      this.palette.content = paletteContent(model, results, Math.max(1, boxWidth - 4), Math.max(1, boxHeight - 2))
      this.syncOverlayEditor(`> ${model.palette.query}`, 2 + model.palette.query.length, 0, boxHeight - 2, boxWidth - 4)
      cursorEditor = this.overlayEditor
    } else if (overlay === "modes") {
      const boxWidth = Math.min(58, contentWidth)
      const boxHeight = Math.min(9, Math.max(1, composerTop))
      this.paletteBox.width = boxWidth
      this.paletteBox.height = boxHeight
      this.paletteBox.left = contentLeft + Math.max(0, contentWidth - boxWidth)
      this.paletteBox.top = Math.max(0, composerTop - boxHeight)
      this.paletteBox.title = ""
      this.paletteBox.bottomTitle = " ←→ turn · esc"
      this.paletteBox.bottomTitleAlignment = "right"
      this.palette.content = modePickerContent(model, Math.max(1, boxWidth - 4))
      cursorEditor = undefined
    } else if (overlay === "files") {
      const entries = filteredFiles(model).map((file) => `@${file}`)
      const maxRows = Math.max(1, Math.min(20, composerTop - 1))
      const visibleEntries = entries.slice(0, Math.max(1, maxRows))
      const innerWidth = Math.max(...visibleEntries.map((entry) => stringWidth(entry)), 19)
      const availableWidth = contentWidth > 4 ? contentWidth - 4 : contentWidth
      const boxWidth = Math.max(1, Math.min(innerWidth + 4, availableWidth))
      const boxHeight = Math.min(Math.max(1, composerTop), Math.max(3, visibleEntries.length + 2))
      this.paletteBox.width = boxWidth
      this.paletteBox.height = boxHeight
      this.paletteBox.left = contentLeft + Math.min(2, Math.max(0, contentWidth - boxWidth))
      this.paletteBox.top = Math.max(0, composerTop - boxHeight)
      this.paletteBox.title = ""
      this.palette.content = filePickerContent(model, visibleEntries, Math.max(1, boxWidth - 4))
    } else if (overlay === "threads") {
      const overlayWidth = Math.max(1, Math.min(140, model.width - 4))
      const overlayHeight = Math.min(Math.max(1, composerTop), Math.max(6, composerTop - 2))
      this.paletteBox.width = overlayWidth
      this.paletteBox.height = overlayHeight
      this.paletteBox.left = Math.max(0, Math.floor((model.width - overlayWidth) / 2))
      this.paletteBox.top = Math.max(0, composerTop - overlayHeight)
      this.paletteBox.title = model.threadSwitcher.kind === "mention" ? " Mention Thread " : " Switch Thread "
      this.paletteBox.titleAlignment = "left"
      this.paletteBox.bottomTitle = " Opt+W/Ctrl+T all workspaces · Esc close "
      this.paletteBox.bottomTitleAlignment = "right"
      this.palette.content = threadSwitcherContent(model, Math.max(1, overlayWidth - 4), Math.max(1, overlayHeight - 2))
      this.syncOverlayEditor(
        `> ${model.threadSwitcher.query}`,
        2 + model.threadSwitcher.query.length,
        1,
        overlayHeight - 2,
        threadSwitcherListWidth(model, overlayWidth - 4),
      )
      cursorEditor = this.overlayEditor
    }
    this.focusEditor(cursorEditor)
    if (cursorEditor !== this.overlayEditor) this.overlayEditor.visible = false
    this.renderer.requestRender()
  }

  private syncOverlayEditor(text: string, cursor: number, top: number, height: number, width: number): void {
    this.overlayEditor.visible = true
    this.overlayEditor.top = top
    this.overlayEditor.width = Math.max(1, width)
    this.overlayEditor.height = Math.max(1, height)
    this.overlayEditor.sync(text, cursor)
  }

  private focusEditor(editor: ProjectedEditorRenderable | undefined): void {
    if (editor === this.focusedEditor) return
    this.stopCursorBlink()
    this.focusedEditor?.blur()
    this.focusedEditor = editor
    this.focusedEditor?.focus()
    if (this.focusedEditor !== undefined) this.startCursorBlink(this.focusedEditor)
  }

  private stopCursorBlink(): void {
    this.cursorGeneration += 1
    this.cancelTimer(this.cursorTimer)
    this.cursorTimer = undefined
  }

  private startCursorBlink(editor: ProjectedEditorRenderable): void {
    editor.showCursor = true
    if (this.destroyed || this.options.animate === false) return
    const generation = this.cursorGeneration
    this.cursorTimer = Effect.runFork(
      cursorBlink(
        Effect.sync(() => {
          if (this.destroyed || this.cursorGeneration !== generation || this.focusedEditor !== editor) return
          editor.showCursor = !editor.showCursor
        }),
      ),
    )
  }

  wakeCursor(): void {
    const editor = this.focusedEditor
    this.stopCursorBlink()
    if (editor !== undefined) this.startCursorBlink(editor)
  }

  destroy(): void {
    this.destroyed = true
    this.scrollGeneration += 1
    this.stopCursorBlink()
    if (this.transcriptAnchorFrame !== undefined) this.renderer.off(CliRenderEvents.FRAME, this.transcriptAnchorFrame)
    this.transcriptAnchorFrame = undefined
    if (this.sidebarLayoutFrame !== undefined) this.renderer.off(CliRenderEvents.FRAME, this.sidebarLayoutFrame)
    this.sidebarLayoutFrame = undefined
    this.transcriptAnchorScrollBy = 0
    this.pendingTranscriptAnchor = undefined
    this.cancelWheelReport()
    if (this.loaderTimer !== undefined) this.clock.clearInterval(this.loaderTimer)
    this.loaderTimer = undefined
    this.cancelTimer(this.welcomeTimer)
    this.welcomeTimer = undefined
    this.cancelTimer(this.toastTimer)
    this.toastTimer = undefined
    this.cancelTimer(this.junkTimer)
    this.junkTimer = undefined
    this.junkBuffer = []
    this.focusEditor(undefined)
    this.composerDrag = undefined
    this.sidebarDrag = undefined
    this.setPointerShape("default")
    this.model = undefined
    this.clearTranscriptChildren()
    this.renderer.root.onMouseDrag = undefined
    this.renderer.root.onMouseUp = undefined
    this.renderer.root.onMouseDragEnd = undefined
    this.renderer.keyInput.off("keypress", this.onKey)
    this.renderer.keyInput.off("paste", this.onPaste)
    this.renderer.off(CliRenderEvents.RESIZE, this.onResize)
    this.renderer.off(CliRenderEvents.SELECTION, this.onSelection)
  }
}

const displayCursorOffset = (model: Model): number => {
  let offset = model.cursor
  for (const attachment of model.pastedText) {
    const tokenOffset = model.input.indexOf(attachment.token)
    if (tokenOffset >= 0 && tokenOffset < model.cursor) offset += attachment.label.length - attachment.token.length
  }
  return offset
}

const composerTextChunks = (model: Model, visibleRows = 3): Array<TextChunk> => {
  const displayed = displayInput(model)
  const cursor = Math.max(0, Math.min(displayed.length, displayCursorOffset(model)))
  const before = displayed.slice(0, cursor)
  const lines = displayed.split("\n")
  const cursorLine = before.split("\n").length - 1
  const firstLine = Math.max(0, Math.min(cursorLine - visibleRows + 1, lines.length - visibleRows))
  const chunks: Array<TextChunk> = []
  lines.slice(firstLine, firstLine + visibleRows).forEach((line, index) => {
    if (index > 0) chunks.push(fg(colors.text)("\n"))
    chunks.push(fg(colors.text)(line))
  })
  return chunks
}

const shortcutRows: ReadonlyArray<ReadonlyArray<readonly [string, string]>> = [
  [
    ["Ctrl+O", "command palette"],
    ["Ctrl+R", "prompt history"],
  ],
  [
    ["Ctrl+V", "paste images"],
    ["Shift+Enter", "newline"],
  ],
  [["Ctrl+S", "switch modes"]],
  [
    ["Ctrl+G", "edit in $EDITOR"],
    ["Opt+T", "toggle file tree"],
  ],
  [
    ["@ / @@", "mention files/threads"],
    ["Tab/Shift+Tab", "navigate messages"],
  ],
  [["?", "toggle this help"]],
]

const sidebarShortcutRows: ReadonlyArray<readonly [string, string]> = [
  ["Opt+S", "toggle changed files"],
  ["Enter", "open selected thread"],
]

const shortcutsContent = (model: Model, innerWidth: number): StyledText => {
  const chunks: Array<TextChunk> = []
  const secondColumn = 32
  const rows =
    innerWidth >= 70
      ? shortcutRows
      : shortcutRows.flatMap((row) => row.map((pair) => [pair] as ReadonlyArray<readonly [string, string]>))
  for (const row of rows) {
    let column = 0
    row.forEach(([keys, description], index) => {
      if (index === 1) {
        chunks.push(fg(colors.text)(" ".repeat(Math.max(1, secondColumn - column))))
        column = secondColumn
      }
      chunks.push(fg(colors.blue)(keys))
      chunks.push(fg(colors.text)(` ${description}`.slice(0, Math.max(0, innerWidth - keys.length))))
      column += keys.length + description.length + 1
    })
    chunks.push(fg(colors.text)("\n"))
  }
  chunks.push(fg(colors.text)("\n"))
  chunks.push(bold(fg(colors.amber)("Sidebar")))
  chunks.push(fg(colors.text)("\n"))
  for (const [keys, description] of sidebarShortcutRows) {
    chunks.push(fg(colors.blue)(keys))
    chunks.push(fg(colors.text)(` ${description}`))
    chunks.push(fg(colors.text)("\n"))
  }
  chunks.push(dim(fg(colors.text)("─".repeat(Math.max(1, innerWidth)))))
  chunks.push(fg(colors.text)("\n"))
  chunks.push(...composerTextChunks(model))
  return new StyledText(chunks)
}

const paletteContent = (
  model: Model,
  results: ReadonlyArray<Command>,
  innerWidth: number,
  innerHeight: number,
): StyledText => {
  const compact = innerHeight < results.length + 3
  const chunks: Array<TextChunk> = compact ? [] : [fg(colors.text)("\n")]
  chunks.push(fg(colors.text)(compact ? "\n" : "\n\n"))
  const categoryWidth = 16
  results.forEach((command, index) => {
    if (index > 0) chunks.push(fg(colors.text)("\n"))
    const selected = index === model.palette.selected
    const keybinding = command.keybinding ?? ""
    const label = command.label
    if (innerWidth < 48) {
      const visible = truncateToWidth(label, innerWidth)
      const padding = " ".repeat(Math.max(0, innerWidth - stringWidth(visible)))
      chunks.push(
        selected
          ? bold(bg(colors.selectionBg)(fg(colors.selectionFg)(`${visible}${padding}`)))
          : bold(fg(colors.text)(visible)),
      )
      return
    }
    const category = command.category.padStart(categoryWidth)
    const used = categoryWidth + 2 + label.length
    const padding = Math.max(1, innerWidth - used - keybinding.length - 1)
    if (selected) {
      chunks.push(bg(colors.selectionBg)(fg(colors.selectionFg)(category)))
      chunks.push(bold(bg(colors.selectionBg)(fg(colors.selectionFg)(`  ${label}`))))
      chunks.push(bg(colors.selectionBg)(fg(colors.selectionFg)(" ".repeat(padding))))
      if (keybinding.length > 0) chunks.push(bold(bg(colors.selectionBg)(fg(colors.selectionHint)(keybinding))))
      chunks.push(bg(colors.selectionBg)(fg(colors.selectionFg)(" ")))
    } else {
      chunks.push(dim(fg(colors.text)(category)))
      chunks.push(bold(fg(colors.text)(`  ${label}`)))
      chunks.push(fg(colors.text)(" ".repeat(padding)))
      if (keybinding.length > 0) chunks.push(bold(fg(colors.blue)(keybinding)))
      chunks.push(fg(colors.text)(" "))
    }
  })
  return new StyledText(chunks)
}

const modeGaugeFill = { low: 2, medium: 19, high: 36, ultra: 54 } as const
const modeAgentLabel = {
  low: "GPT-5.6 Luna low",
  medium: "GPT-5.6 Terra medium",
  high: "GPT-5.6 Sol xhigh",
  ultra: "GPT-5.6 Sol max",
} as const
const modeOracleLabel = {
  low: "GPT-5.6 Sol high",
  medium: "GPT-5.6 Sol high",
  high: "GPT-5.6 Sol max",
  ultra: "GPT-5.6 Sol max",
} as const
const modeDescription = {
  low: "Fast, low-cost mode for small, well-defined tasks",
  medium: "Balanced intelligence, speed, and cost for most tasks",
  high: "Deep reasoning for hard tasks",
  ultra: "The most capable mode for hard, open-ended tasks",
} as const

const modePickerContent = (model: Model, innerWidth: number): StyledText => {
  const modes = ["low", "medium", "high", "ultra"] as const
  const selected = modes[model.modePicker.selected] ?? model.mode
  if (innerWidth < 40)
    return new StyledText([
      bold(fg(colors[selected])(truncateToWidth(selected, innerWidth))),
      fg(colors.text)("\n"),
      fg(colors.muted)(truncateToWidth(modeDescription[selected], innerWidth)),
    ])
  const gaugeWidth = Math.min(54, innerWidth)
  const fill = Math.min(gaugeWidth, modeGaugeFill[selected])
  const chunks: Array<TextChunk> = []
  chunks.push(fg(colors[selected])("•".repeat(fill)))
  chunks.push(fg(colors.muted)("·".repeat(Math.max(0, gaugeWidth - fill))))
  chunks.push(fg(colors.text)("\n"))
  const labelStarts = [0, 16, 33, 49].map((start) => Math.floor((start * gaugeWidth) / 54))
  let column = 0
  modes.forEach((mode, index) => {
    const start = labelStarts[index]!
    chunks.push(fg(colors.text)(" ".repeat(Math.max(0, start - column))))
    chunks.push(mode === selected ? bold(fg(colors[mode])(mode)) : fg(colors.muted)(mode))
    column = Math.max(column, start) + mode.length
  })
  chunks.push(fg(colors.text)("\n\n"))
  chunks.push(bold(fg(colors.text)("Agent:")))
  chunks.push(fg(colors.muted)(`  ${modeAgentLabel[selected]}`))
  chunks.push(fg(colors.text)("\n"))
  chunks.push(bold(fg(colors.text)("Oracle:")))
  chunks.push(fg(colors.muted)(` ${modeOracleLabel[selected]}`))
  chunks.push(fg(colors.text)("\n\n"))
  chunks.push(fg(colors.text)(modeDescription[selected]))
  return new StyledText(chunks)
}

const threadAge = (updatedAt: number | undefined, now: number): string => {
  if (updatedAt === undefined || updatedAt <= 0) return ""
  const minutes = Math.floor(Math.max(0, now - updatedAt) / 60_000)
  if (minutes < 1) return "now"
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

const splitStyledLines = (styled: StyledText): Array<Array<TextChunk>> => {
  const lines: Array<Array<TextChunk>> = [[]]
  for (const chunk of styled.chunks) {
    const pieces = chunk.text.split("\n")
    pieces.forEach((piece, index) => {
      if (index > 0) lines.push([])
      if (piece.length > 0) lines[lines.length - 1]!.push({ ...chunk, text: piece })
    })
  }
  return lines
}

export const clipStyledLine: {
  (line: ReadonlyArray<TextChunk>, width: number): Array<TextChunk>
  (width: number): (line: ReadonlyArray<TextChunk>) => Array<TextChunk>
} = Function.dual(2, (line: ReadonlyArray<TextChunk>, width: number): Array<TextChunk> => {
  const out: Array<TextChunk> = []
  let used = 0
  for (const chunk of line) {
    if (used >= width) break
    const remaining = width - used
    const text = stringWidth(chunk.text) > remaining ? truncateToWidth(chunk.text, remaining) : chunk.text
    if (text.length === 0) continue
    out.push({ ...chunk, text })
    used += stringWidth(text)
  }
  return out
})

const previewTranscriptLines = (
  model: Model,
  width: number,
  maxRows: number,
):
  | {
      readonly lines: ReadonlyArray<ReadonlyArray<TextChunk>>
      readonly total: number
      readonly start: number
    }
  | undefined => {
  const selected = selectedThreadMetadata(model)
  const preview = isReady(model.threadPreview)
    ? selected?.id === model.threadPreview.value.threadId
      ? model.threadPreview.value
      : undefined
    : model.threadPreview._tag === "Loading"
      ? model.threadPreview.previous
      : undefined
  if (preview === undefined || preview.turns.length === 0) return undefined
  let previewModel: Model = { ...initial(model.workspace, model.mode), width: Math.max(8, width), height: 200 }
  preview.turns.forEach((turn, index) => {
    previewModel = projectUnits(
      previewModel,
      Transcript.project(
        `preview-${index}`,
        turn.prompt,
        (turn.events as ReadonlyArray<Event>).map((event) => Object.assign({}, event, { createdAt: event.sequence })),
      ).units,
    )
  })
  const lines = splitStyledLines(renderTranscriptStyled(previewModel)).map((line) => clipStyledLine(line, width))
  const rows = Math.max(1, maxRows)
  const offset = Math.min(model.threadSwitcher.previewScroll, Math.max(0, lines.length - rows))
  const end = lines.length - offset
  const start = Math.max(0, end - rows)
  return { lines: lines.slice(start, end), total: lines.length, start }
}

const threadStats = (thread: ThreadItem): ReadonlyArray<readonly [string, ColorInput]> => {
  if (thread.editTotals === undefined) return []
  return [
    ...(thread.editTotals.added > 0 ? ([[`+${thread.editTotals.added}`, colors.green]] as const) : []),
    ...(thread.editTotals.modified > 0 ? ([[`~${thread.editTotals.modified}`, colors.amber]] as const) : []),
    ...(thread.editTotals.removed > 0 ? ([[`-${thread.editTotals.removed}`, colors.red]] as const) : []),
  ]
}

const threadListRows = (
  model: Model,
  width: number,
  height: number,
  now: number,
): ReadonlyMap<number, ReadonlyArray<TextChunk>> => {
  const threads = filteredThreads(model)
  const listRows = new Map<number, ReadonlyArray<TextChunk>>()
  threads.slice(0, Math.max(1, height - 4)).forEach((thread, index) => {
    const selected = index === model.threadSwitcher.selected
    const age = threadAge(thread.lastActivityAt, now)
    const stats = threadStats(thread)
    const statsWidth = stats.reduce((total, [text]) => total + text.length + 1, 0)
    const rightWidth = statsWidth + (stats.length > 0 && age.length > 0 ? 1 : 0) + age.length
    const titleWidth = Math.max(1, width - rightWidth - 4)
    const title =
      stringWidth(thread.title) > titleWidth
        ? `${truncateToWidth(thread.title, Math.max(0, titleWidth - 1))}…`
        : thread.title
    const leftText = `  ${title}`
    const padding = Math.max(1, width - stringWidth(leftText) - rightWidth - 1)
    if (selected) {
      const right = `${stats.map(([text]) => text).join(" ")}${stats.length > 0 && age.length > 0 ? " " : ""}${age}`
      listRows.set(index + 3, [
        bg(colors.selectionBg)(fg(colors.selectionFg)(leftText)),
        bg(colors.selectionBg)(fg(colors.selectionFg)(" ".repeat(padding))),
        bg(colors.selectionBg)(fg(colors.selectionFg)(`${right} `)),
      ])
      return
    }
    const chunks: Array<TextChunk> = [fg(colors.text)(leftText), fg(colors.text)(" ".repeat(padding))]
    stats.forEach(([text, color], statsIndex) => {
      if (statsIndex > 0) chunks.push(fg(colors.text)(" "))
      chunks.push(fg(color)(text))
    })
    if (stats.length > 0 && age.length > 0) chunks.push(fg(colors.text)(" "))
    chunks.push(fg(colors.muted)(`${age} `))
    listRows.set(index + 3, chunks)
  })
  return listRows
}

export const previewBoxRows: {
  (model: Model, width: number, height: number): ReadonlyMap<number, ReadonlyArray<TextChunk>>
  (width: number, height: number): (model: Model) => ReadonlyMap<number, ReadonlyArray<TextChunk>>
} = Function.dual(3, (model: Model, width: number, height: number): ReadonlyMap<number, ReadonlyArray<TextChunk>> => {
  const rows = new Map<number, ReadonlyArray<TextChunk>>()
  if (width < 8 || height < 4) return rows
  const inner = width - 2
  const preview = selectedThreadMetadata(model)
  const contentWidth = Math.max(1, inner - 3)
  const details =
    preview === undefined
      ? []
      : [
          preview.title,
          preview.workspace,
          [preview.archived ? "archived" : "", preview.unread ? "unread" : "", preview.status]
            .filter((value) => value.length > 0)
            .join(" · "),
        ].filter((value) => value.length > 0)
  const contentRows = Math.max(1, height - 4 - details.length)
  const transcript = previewTranscriptLines(model, contentWidth, contentRows)
  rows.set(0, [fg(colors.muted)(`╭${"─".repeat(inner)}╮`)])
  const header = "Thread Preview"
  const headerLeft = Math.max(0, Math.floor((inner - header.length) / 2))
  rows.set(1, [
    fg(colors.muted)("│"),
    fg(colors.text)(" ".repeat(headerLeft)),
    fg(colors.muted)(header),
    fg(colors.text)(" ".repeat(Math.max(0, inner - headerLeft - header.length))),
    fg(colors.muted)("│"),
  ])
  details.forEach((line, index) => {
    const visible = truncateToWidth(line, contentWidth)
    rows.set(2 + index, [
      fg(colors.muted)("│"),
      fg(colors.text)("  "),
      fg(colors.text)(visible),
      fg(colors.text)(" ".repeat(Math.max(0, contentWidth - stringWidth(visible)))),
      fg(colors.text)(" "),
      fg(colors.muted)("│"),
    ])
  })
  if (transcript !== undefined) {
    const startRow = height - 1 - transcript.lines.length
    const scrollable = transcript.total > contentRows
    const thumb = scrollable
      ? Math.round((transcript.start / Math.max(1, transcript.total - contentRows)) * Math.max(0, contentRows - 1))
      : -1
    transcript.lines.forEach((line, index) => {
      const textWidth = line.reduce((total, chunk) => total + stringWidth(chunk.text), 0)
      const contentRow = startRow + index
      rows.set(contentRow, [
        fg(colors.muted)("│"),
        fg(colors.text)("  "),
        ...line,
        fg(colors.text)(" ".repeat(Math.max(0, contentWidth - textWidth))),
        scrollable ? fg(colors.muted)(contentRow - 2 === thumb ? "█" : "│") : fg(colors.text)(" "),
        fg(colors.muted)("│"),
      ])
    })
  } else if (!isLoading(model.threadPreview)) {
    const status = "No preview"
    const statusLeft = Math.max(0, Math.floor((inner - status.length) / 2))
    rows.set(2 + details.length, [
      fg(colors.muted)("│"),
      fg(colors.text)(" ".repeat(statusLeft)),
      dim(fg(colors.text)(status)),
      fg(colors.text)(" ".repeat(Math.max(0, inner - statusLeft - status.length))),
      fg(colors.muted)("│"),
    ])
  }
  for (let row = 2; row < height - 1; row += 1)
    if (!rows.has(row))
      rows.set(row, [fg(colors.muted)("│"), fg(colors.text)(" ".repeat(inner)), fg(colors.muted)("│")])
  rows.set(height - 1, [fg(colors.muted)(`╰${"─".repeat(inner)}╯`)])
  return rows
})

const threadSwitcherContent = (model: Model, innerWidth: number, innerHeight: number): StyledText => {
  const horizontal = model.width >= 120
  const showPreview = horizontal || innerHeight >= 9
  const layoutWidth = Math.max(1, innerWidth - 1)
  const listWidth = threadSwitcherListWidth(model, innerWidth)
  const listHeight = horizontal
    ? innerHeight
    : showPreview
      ? Math.max(5, Math.min(innerHeight - 4, Math.floor(innerHeight * 0.42)))
      : innerHeight
  const previewWidth = horizontal ? Math.max(1, layoutWidth - listWidth - 2) : layoutWidth
  const previewHeight = horizontal ? Math.max(4, innerHeight - 3) : Math.max(4, innerHeight - listHeight - 2)
  const previewTop = horizontal ? 1 : listHeight
  const now = Effect.runSync(Clock.currentTimeMillis)
  const listRows = threadListRows(model, listWidth, listHeight, now)
  const previewRows = previewBoxRows(model, previewWidth, previewHeight)
  const chunks: Array<TextChunk> = []
  for (let row = 0; row < innerHeight; row += 1) {
    if (row > 0) chunks.push(fg(colors.text)("\n"))
    if (!horizontal && showPreview && row >= previewTop) {
      const previewRow = previewRows.get(row - previewTop)
      if (previewRow !== undefined) chunks.push(...previewRow)
      continue
    }
    if (row === 1 && row < listHeight) {
      chunks.push(fg(colors.text)(" ".repeat(listWidth)))
    } else {
      const listRow = listRows.get(row)
      if (listRow === undefined) chunks.push(fg(colors.text)(" ".repeat(listWidth)))
      else {
        chunks.push(...listRow)
        const used = listRow.reduce((total, chunk) => total + stringWidth(chunk.text), 0)
        chunks.push(fg(colors.text)(" ".repeat(Math.max(0, listWidth - used))))
      }
    }
    if (horizontal) {
      chunks.push(fg(colors.text)("  "))
      chunks.push(...(previewRows.get(row - previewTop) ?? [fg(colors.text)(" ".repeat(previewWidth))]))
    }
  }
  return new StyledText(chunks)
}

const threadSwitcherListWidth = (model: Model, innerWidth: number): number => {
  const layoutWidth = Math.max(1, innerWidth - 1)
  return model.width >= 120 ? Math.max(1, Math.floor((layoutWidth - 2) / 2)) : layoutWidth
}

const filePickerContent = (model: Model, entries: ReadonlyArray<string>, innerWidth: number): StyledText => {
  const chunks: Array<TextChunk> = []
  entries.forEach((entry, index) => {
    if (index > 0) chunks.push(fg(colors.text)("\n"))
    const marker = /^@{1,2}/.exec(entry)?.[0] ?? ""
    const rest = entry.slice(marker.length)
    const markerWidth = stringWidth(marker)
    const clipped = truncateToWidth(rest, Math.max(0, innerWidth - markerWidth))
    const padding = " ".repeat(Math.max(0, innerWidth - markerWidth - stringWidth(clipped)))
    if (index === model.filePicker.selected) {
      chunks.push(bg(colors.muted)(fg(colors.teal)(marker)))
      chunks.push(bg(colors.muted)(fg(colors.text)(clipped)))
      chunks.push(bg(colors.muted)(fg(colors.text)(padding)))
    } else {
      chunks.push(fg(colors.teal)(marker))
      chunks.push(fg(colors.text)(clipped))
    }
  })
  if (chunks.length === 0)
    chunks.push(
      dim(
        fg(colors.text)(
          truncateToWidth(isLoading(model.filePicker.items) ? "Loading files" : "no matches", innerWidth),
        ),
      ),
    )
  return new StyledText(chunks)
}

const panelLoading = (model: Model): string | undefined =>
  model.threadLoading
    ? "Loading Thread"
    : model.changedFilesOpen && isLoading(model.changedFiles)
      ? "Loading changed files"
      : (model.workspaceFilesOpen || model.filePicker.open) && isLoading(model.filePicker.items)
        ? "Loading files"
        : undefined

const compactWorkspace = (workspace: string): string => {
  const home = workspace.replace(/^\/Users\/[^/]+(?=\/|$)/, "~")
  const segments = home.split("/").filter((segment) => segment.length > 0)
  if (segments.length <= 5) return home
  return [segments.slice(0, 2).join("/"), "…", segments.slice(-2).join("/")].join("/")
}

const formatCost = (usd: number): string =>
  usd.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: Math.abs(usd) < 0.01 ? 3 : 2,
  })

const welcomeMarkFrame = (rows: ReadonlyArray<string>): ReadonlyArray<string> => [
  "                                        ",
  "                                        ",
  "                                        ",
  ...rows.map(shiftWelcomeMarkRow),
]

const shiftWelcomeMarkRow = (row: string): string => ` ${row}`.slice(0, 40)

const welcomeMarkFrames = [
  welcomeMarkFrame([
    "            •••••••••••••               ",
    "         ••••••••••●●••••••••           ",
    "      •••••●●●●●●●●•••••••••••••        ",
    "    •••••●●●•••••••••••••••••••••       ",
    "   •••••●●•••••••●●●•••••••••••••••     ",
    "  ••••●●•••••●●●•••●●●●●●●••••••••••    ",
    " ••••●●••••●●●•••●●●●●●●●●••••••••••    ",
    " ••••●••••●●•••••••••••••••••••••••••   ",
    "••••••••••●●•••••••••••••••••••••••••   ",
    "••••••••••●●•••••••••••••••••••••••••   ",
    " ••••••••••••••••••••••••••••••••••••   ",
    " •••••••••••••••••••••••••••••••••••    ",
    "  ••••••••••••••••••••••••••••••••••    ",
    "   ••••••••••••••••••••••••••••••••     ",
    "    •••••••••••••••••••••••••••••       ",
    "      •••••••••••••••••••••••••         ",
    "         ••••••••••••••••••••           ",
    "             ···········•               ",
  ]),
  welcomeMarkFrame([
    "             ••••••••••••               ",
    "         ••••••••••••••••••••           ",
    "      ••●●•••••●●●•••••••••••••         ",
    "     ••••●●•●●•••••••••••••••••••       ",
    "   ••••●●●●•••••••••••••••••••••••      ",
    "  •••••••••••●●••••••••••••••••••••     ",
    " •••••●●•••●●•••••●●●●●●●•••••••••••    ",
    " ••••●••••●••••••••●●●●•••••••••••••    ",
    " ••••●••••●••••••••••••••••••••••••••   ",
    " •••••••••●●•••••••••••••••••••••••••   ",
    " •••••••••••••••••••••••••••••••••••    ",
    " •••••••••••••••••••••••••••••••••••    ",
    "  •••••••••••••••••••••••••••••••••     ",
    "   •••••••••••••••••••••••••••••••      ",
    "     ••••••••••••••••••••••••••••       ",
    "      •••••••••••••••••••••••••         ",
    "         •••••••••••••••••••            ",
    "              ·········•                ",
  ]),
  welcomeMarkFrame([
    "              ••••••••••                ",
    "          ••••••••••••••••••            ",
    "       ●●••••••●●●•••••••••••••         ",
    "     ●●•••••●●•••••••••••••••••••       ",
    "    •••••●●●••••••••••••••••••••••      ",
    "   ••••●●••••••••••••••••••••••••••     ",
    "  ••••●●••••••••••••••••••••••••••••    ",
    " ••••••••••••••••●●●●●●•••••••••••••    ",
    " •••••••••••••••••••••••••••••••••••    ",
    " ••••●••••●●••••••••••••••••••••••••    ",
    " •••••••••••••••••••••••••••••••••••    ",
    "  ••••••••••••••••••••••••••••••••••    ",
    "  •••••••••••••••••••••••••••••••••     ",
    "    ••••••••••••••••••••••••••••••      ",
    "     •••••••••••••••••••••••••••        ",
    "       ••••••••••••••••••••••••         ",
    "          ••••••••••••••••••            ",
    "               ·······•                 ",
  ]),
  welcomeMarkFrame([
    "               ••••••••                 ",
    "          ••●●••••••••••••••            ",
    "       •••••••••••••••••••••••          ",
    "     ••••••●●•••••••••••••••••••        ",
    "    •••••●●•••••••••••••••••••••••      ",
    "   ••••••••••••••••••••••••••••••••     ",
    "  •••••••••••••••••••••••••••••••••     ",
    "  ••••••••••••••●●●●••••••••••••••••    ",
    " •••••••••••••••●●●●••••••••••••••••    ",
    " •••••••••●•••••••••••••••••••••••••    ",
    "  ••••••••••••••••••••••••••••••••••    ",
    "  •••••••••••••••••••••••••••••••••     ",
    "   ••••••••••••••••••••••••••••••••     ",
    "    ••••••••••••••••••••••••••••••      ",
    "     •••••••••••••••••••••••••••        ",
    "       •••••••••••••••••••••••          ",
    "          ·················             ",
    "                ·····•                  ",
  ]),
  welcomeMarkFrame([
    "                ••••••                  ",
    "          •••••••••••••••••             ",
    "       •••••••••••••••••••••••          ",
    "     •••••••••••••••••••••••••••        ",
    "    •••••••••••••••••••••••••••••       ",
    "   •••••••••••••••••••••••••••••••      ",
    "  •●●••••••••••••••••••••••••••••••     ",
    "  ••••••••••••●●●•••••••••••••••••••    ",
    " ••••••••••••●●●●●●•••••••••••••••••    ",
    "  ••••••••••••••••••••••••••••••••••    ",
    "  ••••••••••••••••••••••••••••••••••    ",
    "  •••••••••••••••••••••••••••••••••     ",
    "   •••••••••••••••••••••••••••••••      ",
    "    •••••••••••••••••••••••••••••       ",
    "      ••••••••••••••••••••••••••        ",
    "        ••••••••••••••••••••••          ",
    "          •···············•             ",
    "                 ••••                   ",
  ]),
  welcomeMarkFrame([
    "                •••••                   ",
    "           ••●●••••••••••••             ",
    "        ••••••••••••••••••••••          ",
    "      ••••••••••••••••••••••••••        ",
    "    •●●••••••••••••••••••••••••••       ",
    "   •••••••••••●●••••••••••••••••••      ",
    "  ••••••••••●●•••••••••••••••••••••     ",
    "  ••••••••••●•••••••••••••••••••••••    ",
    "  ••••••••●●●●●●••••••••••••••••••••    ",
    "  •••••••••●●●●●••••••••••••••••••••    ",
    "  ••••••••••••••••••••••••••••••••••    ",
    "  •••••••••••••••••••••••••••••••••     ",
    "   •••••••••••••••••••••••••••••••      ",
    "    •••••••••••••••••••••••••••••       ",
    "      ••••••••••••••••••••••••••        ",
    "        ••••••••••••••••••••••          ",
    "          •···············•             ",
    "                  ••                    ",
  ]),
  welcomeMarkFrame([
    "                ••••••                  ",
    "          •••••••••••••••••             ",
    "        •●●•••••••••••••••••••          ",
    "      ••••••••••••••••••••••••••        ",
    "    •••••••••••••••••••••••••••••       ",
    "   ••••••••••••••●●●●•••••••••••••      ",
    "  •••••••••••••●●●•••••••••••••••••     ",
    "  •••••••●••••••••••••••••••••••••••    ",
    "  •••••••●●●●●●•••••••••••••••••••••    ",
    "  •••••••●●●●●••••••••••••••••••••••    ",
    "  ••••••••••••••••••••••••••••••••••    ",
    "  •••••••••••••••••••••••••••••••••     ",
    "   •••••••••••••••••••••••••••••••      ",
    "    •••••••••••••••••••••••••••••       ",
    "     •••••••••••••••••••••••••••        ",
    "       •••••••••••••••••••••••          ",
    "          •···············•             ",
    "                 •••                    ",
  ]),
  welcomeMarkFrame([
    "               ••••••••                 ",
    "          ••••••••••••••••••            ",
    "       •••••••••••••••••••••••          ",
    "     •••••••••••••••••••••••••••        ",
    "    •••••••••••●●●••••••••••••••••      ",
    "   •••••••••●●●••••••••••••••••••••     ",
    "  •••••••••●●●●••••••••••••••••••••     ",
    "  •••••●•••●●●••••••••••••••••••••••    ",
    " ••••••●●●●●●●••••••••••••••••••••••    ",
    " •••••••●●●●●•••••••••••••••••••••••    ",
    "  ••••••••••••••••••••••••••••••••••    ",
    "  •••••••••••••••••••••••••••••••••     ",
    "   ••••••••••••••••••••••••••••••••     ",
    "    ••••••••••••••••••••••••••••••      ",
    "     •••••••••••••••••••••••••••        ",
    "       •••••••••••••••••••••••          ",
    "          ·················             ",
    "                ·····•                  ",
  ]),
  welcomeMarkFrame([
    "              ••••••••••                ",
    "         •••••••••••••••••••            ",
    "       ••••••••••••••••••••••••         ",
    "     ••••••••●●●●••••••••••••••••       ",
    "   •••••••●●●•••••••••••••••••••••      ",
    "  ••••••●●●••••••••••••••••••••••••     ",
    "  ••••••●●●•••••••••••••••••••••••••    ",
    " ••••●•●●●●•••••••••••••••••••••••••    ",
    " ••••●●●●●●●●●••••••••••••••••••••••    ",
    " •••••••●●●•••••••••••••••••••••••••    ",
    " •••••••••••••••••••••••••••••••••••    ",
    "  ••••••••••••••••••••••••••••••••••    ",
    "  •••••••••••••••••••••••••••••••••     ",
    "   •••••••••••••••••••••••••••••••      ",
    "     ••••••••••••••••••••••••••••       ",
    "       ••••••••••••••••••••••••         ",
    "         •••••••••••••••••••            ",
    "              •·······•                 ",
  ]),
  welcomeMarkFrame([
    "            •••••••••••••               ",
    "        •••••●●●●●●••••••••••           ",
    "      •••●●●●•••••••••••••••••••        ",
    "    ••●●●●•••••●●••••••••••••••••       ",
    "   ••●●●••••●●●●●••••••••••••••••••     ",
    "  •••●●••••●●●●•••••••••••••••••••••    ",
    " ••●●●•••••●●●●●••••••••••••••••••••    ",
    " ••●●●●●●●●●●••••●●••••••••••••••••••   ",
    " ••••●●●●●●●●••••••••••••••••••••••••   ",
    " •••••••••••●●•••••••••••••••••••••••   ",
    " ••••••••••••••••••••••••••••••••••••   ",
    " •••••••••••••••••••••••••••••••••••    ",
    "  ••••••••••••••••••••••••••••••••••    ",
    "   ••••••••••••••••••••••••••••••••     ",
    "    •••••••••••••••••••••••••••••       ",
    "      •••••••••••••••••••••••••         ",
    "         ••••••••••••••••••••           ",
    "             ···········•               ",
  ]),
] as const

const modeRgb = (mode: Mode): readonly [number, number, number] => {
  const value = colors[mode]
  return [
    Number.parseInt(value.slice(1, 3), 16),
    Number.parseInt(value.slice(3, 5), 16),
    Number.parseInt(value.slice(5, 7), 16),
  ]
}

const hex2 = (value: number): string => Math.round(value).toString(16).padStart(2, "0")

const welcomeMarkColor = (row: number, mode: Mode): readonly [number, number, number] => {
  if (mode !== "ultra") return modeRgb(mode)
  const clamped = Math.max(0, Math.min(1, row))
  const top = [92, 225, 152] as const
  const middle = [64, 140, 124] as const
  const bottom = [36, 64, 168] as const
  return clamped < 0.48 ? mix(top, middle, clamped / 0.48) : mix(middle, bottom, (clamped - 0.48) / 0.52)
}

const mix = (
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  tValue: number,
): readonly [number, number, number] => {
  const clamped = Math.max(0, Math.min(1, tValue))
  return [a[0] + (b[0] - a[0]) * clamped, a[1] + (b[1] - a[1]) * clamped, a[2] + (b[2] - a[2]) * clamped]
}

const welcomeContent = (width: number, height: number, phase: number, mode: Mode): StyledText => {
  if (height < 20)
    return new StyledText([
      fg(colors.text)("\n"),
      fg(colors[mode])(`${" ".repeat(Math.max(0, Math.floor((width - 15) / 2)))}Welcome to Rika`),
      fg(colors.text)("\n\n"),
      fg(colors.text)(`${" ".repeat(Math.max(0, Math.floor((width - 24) / 2)))}ctrl+o commands   ? help`),
    ])
  const frame = welcomeMarkFrames[(phase + 5) % welcomeMarkFrames.length] ?? welcomeMarkFrames[0]
  const pattern = frame.slice(3)
  const area = Math.max(1, height - spacing.inputHeight)
  const top = Math.max(0, Math.floor((area - pattern.length) / 2))
  const center = Math.floor(width / 2)
  const logoLeft = Math.max(0, center - 43)
  const textGap = Math.max(1, center - 1 - logoLeft - 40)
  const visiblePattern = pattern.slice(0, Math.max(1, area - top))
  const chunks: TextChunk[] = [fg(colors.text)("\n".repeat(top))]
  const copy = new Map<number, ReadonlyArray<TextChunk>>([
    [4, [bold(fg(colors[mode])("Welcome to Rika"))]],
    [7, [bold(fg(colors.text)("ctrl+o")), fg(colors.muted)(" for commands")]],
    [8, [bold(fg(colors.text)("?")), fg(colors.muted)(" for shortcuts")]],
  ])
  for (let row = 0; row < visiblePattern.length; row += 1) {
    if (row > 0) chunks.push(fg(colors.text)("\n"))
    chunks.push(fg(colors.text)(" ".repeat(logoLeft)))
    for (const glyph of visiblePattern[row] ?? "") {
      if (glyph === " ") chunks.push(fg(colors.text)(glyph))
      else {
        const [red, green, blue] = welcomeMarkColor(row / 17, mode)
        chunks.push(fg(`#${hex2(red)}${hex2(green)}${hex2(blue)}`)(glyph))
      }
    }
    const suffix = copy.get(row)
    if (suffix !== undefined) {
      chunks.push(fg(colors.text)(" ".repeat(textGap)))
      chunks.push(...suffix)
    }
  }
  return new StyledText(chunks)
}

export const create = (handlers: Handlers) =>
  Effect.tryPromise({
    try: () =>
      createCliRenderer({
        screenMode: "alternate-screen",
        exitOnCtrlC: false,
        useMouse: true,
        enableMouseMovement: true,
      }),
    catch: adapterError,
  }).pipe(
    Effect.flatMap((renderer) =>
      Effect.try({
        try: () => {
          let surface: Surface | undefined
          let released = false
          const releaseTerminal = () => {
            if (released) return
            released = true
            try {
              surface?.destroy()
            } catch {
            } finally {
              try {
                renderer.destroy()
              } catch {}
            }
          }
          const suspendTerminal = () => {
            if (released) return
            try {
              renderer.suspend()
            } catch (cause) {
              releaseTerminal()
              throw cause
            }
          }
          const resumeTerminal = () => {
            if (released) return
            try {
              renderer.resume()
              surface?.wakeCursor()
            } catch (cause) {
              releaseTerminal()
              throw cause
            }
          }
          try {
            renderer.setBackgroundColor("transparent")
            handlers.resize(renderer.terminalWidth, renderer.terminalHeight)
            surface = new Surface(renderer, handlers)
            return { surface, releaseTerminal, suspendTerminal, resumeTerminal }
          } catch (cause) {
            releaseTerminal()
            throw cause
          }
        },
        catch: adapterError,
      }),
    ),
  )
