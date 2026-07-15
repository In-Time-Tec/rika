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
  underline,
  RGBA,
  StyledText,
  type TextChunk,
} from "@opentui/core"
import type { ColorInput, KeyEvent, MouseEvent, PasteEvent } from "@opentui/core"
import cliSpinners from "cli-spinners"
import { Clock, Effect, Fiber, Function, Schedule } from "effect"
import stringWidth from "string-width"
import { fromOpenTui, type Key } from "./keys"
import {
  composerHeight,
  defaultReasoningEffort,
  displayInput,
  filteredFiles,
  filteredThreads,
  initial,
  isLoading,
  isNarrow,
  isReady,
  pastedTextTokenAt,
  readyOr,
  selectedThreadMetadata,
  type Mode,
  type Model,
  type TranscriptItem,
} from "./view-state"
import type { ThreadItem, TranscriptBlock } from "./view-state"
import { projectTurn, type Event } from "./execution-events"
import { filter, type Command } from "./palette"
import { colors, spacing } from "./theme"
import { renderMarkdown, renderMarkdownStyled } from "./markdown-renderer"
import { renderDiff, renderDiffStyled } from "./diff-renderer"
import { renderPierreDiff } from "./pierre-diff"
import { renderTool } from "./tool-renderer"
import {
  isExpandableUnit,
  orderedTranscriptItems,
  toolKind,
  transcriptUnitId,
  transcriptUnits,
  toolDetails,
  type PathTarget,
  type ToolKind,
} from "./transcript-units"

export const spinnerFrames: ReadonlyArray<string> = cliSpinners.dots.frames
export const spinnerInterval = 160
export const idleSpinnerFrame = "⠿"
export const loaderFrame: {
  (phase: string | undefined, frame: number): string
  (frame: number): (phase: string | undefined) => string
} = Function.dual(2, (phase: string | undefined, frame: number): string =>
  phase === undefined ? "" : spinnerFrames[frame % spinnerFrames.length]!,
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
        return block.expanded ? `◇ Reasoning\n  ${block.text}` : "◇ Reasoning (collapsed)"
      case "ToolCall": {
        return renderTool(block, width)
      }
      case "ToolResult":
        return `${block.failed ? "✕" : "✓"} Result\n  ${block.output}`
      case "Diff":
        return block.expanded === true ? `Δ ${block.path} ▾\n${renderDiff(block.patch, width)}` : `Δ ${block.path} ▸`
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
      case "Queued":
        return `↳ Queued\n  ${block.prompt}`
      case "ChildAgent": {
        const icon = block.status === "running" ? "⠿" : block.status === "complete" ? "✓" : "✗"
        return `${icon} Subagent ${block.status === "running" ? "working" : "finished"} ▸\n  ${block.name} · ${block.summary}`
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

const threadSidebarWidth = 36

export const renderSidebar: {
  (spinnerFrame?: string): (model: Model) => StyledText
  (model: Model): StyledText
  (model: Model, spinnerFrame?: string): StyledText
} = Function.dual(
  (args) => args.length > 1 || typeof args[0] !== "string",
  (model: Model, spinnerFrame = idleSpinnerFrame): StyledText => {
    const chunks: Array<TextChunk> = []
    const threads = model.threads as ReadonlyArray<ThreadItem>
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
        const title = truncateToWidth(thread.title, threadSidebarWidth - 4)
        const padding = " ".repeat(Math.max(0, threadSidebarWidth - 4 - stringWidth(title)))
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

const truncateToWidth = (text: string, width: number): string => {
  let truncated = ""
  for (const character of text) {
    if (stringWidth(truncated + character) > width) break
    truncated += character
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
        if (!showCounts) {
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

const sidebarInnerWidth = (model: Model): number => Math.max(8, model.sidebarWidth - 8)

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
          : renderMarkdown(entry.text),
    )
    .join("\n\n")
  let queueIndex = 0
  const blocks = (model.blocks as ReadonlyArray<TranscriptBlock>)
    .map((block) => {
      if (block._tag === "Permission" && block.status === "pending") {
        const options = ["Allow once", "Always", "Deny"]
          .map((option, index) => `${index === model.permissionSelection ? "›" : " "} ${option}`)
          .join("   ")
        return `${renderBlock(block, model.width)}\n  ${options}`
      }
      if (block._tag === "Queued") {
        const rendered = `  ${renderBlock(block, model.width)}`
        queueIndex += 1
        return rendered
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
        : renderMarkdown(entry.text)
  })
  return welcome + ordered.join("\n\n")
}

const toolInputValue = (input: string): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(input)
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

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
  return inputString(value, ["command", "cmd", "script"]) ?? block.input
}

const exploreChildLabel = (unit: ToolUnit): string => {
  const value = toolInputValue(unit.block.input)
  if (unit.kind === "read") return `Read ${inputString(value, ["path", "file_path", "file"]) ?? unit.block.name}`
  const pattern = inputString(value, ["pattern", "query", "glob", "path"])
  return `${unit.block.name === "grep" ? "Grep" : "Searched"} ${pattern ?? ""}`.trimEnd()
}

const plural = (count: number, singular: string): string => `${count} ${singular}${count === 1 ? "" : "s"}`

const iconChar = (failed: boolean, running: boolean, frame = idleSpinnerFrame): string =>
  running ? frame : failed ? "✕" : "✓"

const markerText = (expanded: boolean): string => (expanded ? " ▾" : " ▸")

export interface UnitLineRange {
  readonly start: number
  readonly end: number
  readonly unit: string
  readonly expandable: boolean
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
    const source = (model.items as ReadonlyArray<TranscriptItem>).slice(Math.max(0, windowEnd - limit), windowEnd)
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
    return { kind: toolKind(block.name), block, index }
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
    let renderedUnits = 0
    const newBlockGap = () => {
      if (renderedUnits > 0) append(fg(colors.text)("\n\n"))
      renderedUnits += 1
    }
    const statusIcon = (failed: boolean, running: boolean): TextChunk =>
      running ? fg(colors.blue)(spinnerFrame) : failed ? fg(colors.red)("✕") : fg(colors.green)("✓")
    const marker = (expanded: boolean): TextChunk => fg(colors.subtle)(expanded ? " ▾" : " ▸")
    const highlight = (text: string) => append(bold(fg(colors.blue)(text)))
    const renderEntryBody = (index: number) => {
      const entry = model.entries[index]!
      if (entry.role === "assistant") {
        appendAll(renderMarkdownStyled(entry.text.trimEnd()))
        return
      }
      if (entry.role === "notice") {
        if (entry.text === "cancelled") append(fg(colors.muted)("cancelled"))
        else append(fg(colors.amber)(`! ${entry.text}`))
        return
      }
      const wrapWidth = Math.max(8, model.width - spacing.transcript * 2 - 2)
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
    const renderExploreBody = (units: ReadonlyArray<ToolUnit>, selected: boolean) => {
      const files = units.filter((unit) => unit.kind === "read").length
      const searches = units.length - files
      const failed = units.some((unit) => unit.block.status === "failed")
      const running = units.some((unit) => unit.block.status === "running")
      const expanded = units.some((unit) => unit.block.expanded === true)
      const counts = [
        ...(files > 0 ? [plural(files, "file")] : []),
        ...(searches > 0 ? [plural(searches, "search").replace("searchs", "searches")] : []),
      ].join(", ")
      if (selected)
        highlight(
          `${iconChar(failed, running, spinnerFrame)} ${running ? "Exploring" : "Explored"} ${counts.length > 0 ? counts : "workspace"}${markerText(expanded)}`,
        )
      else {
        append(statusIcon(failed, running))
        append(fg(colors.text)(running ? " Exploring" : " Explored"))
        append(dim(fg(colors.text)(` ${counts.length > 0 ? counts : "workspace"}`)))
        append(marker(expanded))
      }
      if (expanded)
        for (const unit of units) {
          append(fg(colors.text)("\n "))
          append(statusIcon(unit.block.status === "failed", unit.block.status === "running"))
          const label = exploreChildLabel(unit)
          const verbEnd = label.indexOf(" ")
          if (verbEnd === -1) append(fg(colors.text)(` ${label}`))
          else {
            append(fg(colors.text)(` ${label.slice(0, verbEnd)}`))
            append(dim(fg(colors.text)(label.slice(verbEnd))))
          }
        }
    }
    const renderEditBody = (units: ReadonlyArray<ToolUnit>, diffs: ReadonlyArray<number>, selected: boolean) => {
      const failed = units.some((unit) => unit.block.status === "failed")
      const running = units.some((unit) => unit.block.status === "running")
      const expanded = units.some((unit) => unit.block.expanded === true)
      const paths = [
        ...new Set(
          units.map(
            (unit) => inputString(toolInputValue(unit.block.input), ["path", "file_path", "file"]) ?? unit.block.name,
          ),
        ),
      ]
      let added = 0
      let removed = 0
      for (const diffIndex of diffs) {
        const diff = model.blocks[diffIndex] as Extract<TranscriptBlock, { _tag: "Diff" }>
        const [a, r] = diffCounts(diff.patch)
        added += a
        removed += r
      }
      const label = paths.length === 1 ? paths[0] : plural(paths.length, "file")
      const counts = added > 0 || removed > 0 ? ` +${added} -${removed}` : ""
      if (selected)
        highlight(
          `${iconChar(failed, running)} ${running ? "Editing" : "Edited"} ${label}${counts}${markerText(expanded)}`,
        )
      else {
        append(statusIcon(failed, running))
        append(fg(colors.text)(running ? " Editing" : " Edited"))
        append(dim(fg(colors.text)(` ${label}`)))
        if (added > 0 || removed > 0) {
          append(fg(colors.green)(` +${added}`))
          append(fg(colors.red)(` -${removed}`))
        }
        append(marker(expanded))
      }
      if (expanded)
        for (const diffIndex of diffs) {
          const diff = model.blocks[diffIndex] as Extract<TranscriptBlock, { _tag: "Diff" }>
          append(fg(colors.text)("\n"))
          appendAll(renderPierreDiff(diff.patch, model.width) ?? renderDiffStyled(diff.patch, model.width))
        }
    }
    const renderShellSingleBody = (unit: ToolUnit, selected: boolean) => {
      const command = shellCommandText(unit.block)
      const failed = unit.block.status === "failed"
      const expanded = unit.block.expanded === true
      const lines = command.split("\n")
      if (selected) {
        const exit = failed ? " (exit code: 1)" : ""
        highlight(`$ ${lines.join("\n    ")}${exit}${markerText(expanded)}`)
      } else {
        lines.forEach((current, lineIndex) => {
          if (lineIndex === 0) {
            append(dim(fg(colors.text)("$ ")))
            append(fg(colors.text)(current))
          } else append(fg(colors.text)(`\n    ${current}`))
        })
        if (failed) append(fg(colors.red)(" (exit code: 1)"))
        append(marker(expanded))
      }
      if (expanded && unit.block.output !== undefined) {
        append(fg(colors.text)("\n"))
        append(dim(fg(colors.text)(unit.block.output.split("\n").slice(0, 12).join("\n"))))
      }
    }
    const renderShellBody = (units: ReadonlyArray<ToolUnit>, selected: boolean) => {
      if (units.length === 1) {
        renderShellSingleBody(units[0]!, selected)
        return
      }
      const failedCount = units.filter((unit) => unit.block.status === "failed").length
      const running = units.some((unit) => unit.block.status === "running")
      const expanded = units.some((unit) => unit.block.expanded === true)
      if (selected)
        highlight(
          `${iconChar(failedCount > 0, running)} ${running ? "Running" : "Ran"} ${plural(units.length, "command")}${failedCount > 0 ? `, ${failedCount} failed` : ""}${markerText(expanded)}`,
        )
      else {
        append(statusIcon(failedCount > 0, running))
        append(fg(colors.text)(running ? " Running" : " Ran"))
        append(fg(colors.text)(` ${plural(units.length, "command")}`))
        if (failedCount > 0) append(fg(colors.muted)(`, ${failedCount} failed`))
        append(marker(expanded))
      }
      if (expanded)
        for (const unit of units) {
          append(fg(colors.text)("\n "))
          append(statusIcon(unit.block.status === "failed", unit.block.status === "running"))
          append(fg(colors.muted)(` $ ${shellCommandText(unit.block).split("\n")[0]}`))
        }
    }
    const renderOtherToolBody = (unit: ToolUnit, selected: boolean) => {
      const failed = unit.block.status === "failed"
      const running = unit.block.status === "running"
      const expanded = unit.block.expanded === true
      if (selected)
        highlight(
          `${iconChar(failed, running)} ${running ? "Running tool" : "Ran tool"} ${unit.block.name}${markerText(expanded)}`,
        )
      else {
        append(statusIcon(failed, running))
        append(fg(colors.text)(running ? " Running tool " : " Ran tool "))
        append(fg(colors.text)(unit.block.name))
        append(marker(expanded))
      }
      if (expanded && unit.block.output !== undefined) {
        append(fg(colors.text)("\n"))
        append(dim(fg(colors.text)(unit.block.output.split("\n").slice(0, 12).join("\n"))))
      }
    }
    const renderChildAgentBody = (block: Extract<TranscriptBlock, { _tag: "ChildAgent" }>) => {
      const running = block.status === "running"
      const name = block.name.replace(/^rika-/, "")
      const display = name.charAt(0).toUpperCase() + name.slice(1)
      const phrase =
        display === "Oracle"
          ? running
            ? "Oracle is thinking"
            : "Oracle has spoken"
          : display === "Librarian"
            ? running
              ? "Librarian is researching"
              : "Librarian researched"
            : `${display} ${running ? "working" : block.status === "failed" ? "failed" : "finished"}`
      append(statusIcon(block.status === "failed", running))
      append(fg(colors.text)(` ${phrase}`))
      append(marker(false))
    }
    const renderDiffBody = (index: number, selected: boolean) => {
      const block = model.blocks[index] as Extract<TranscriptBlock, { _tag: "Diff" }>
      if (block.expanded === true) {
        append(bold(fg(selected ? colors.blue : colors.muted)(`Δ ${block.path} ▾\n`)))
        appendAll(renderPierreDiff(block.patch, model.width) ?? renderDiffStyled(block.patch, model.width))
        return
      }
      const [added, removed] = diffCounts(block.patch)
      if (selected) highlight(`✓ Edited ${block.path} +${added} -${removed} ▸`)
      else {
        append(fg(colors.green)("✓"))
        append(fg(colors.text)(` Edited ${block.path}`))
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
      const selected = expandable && model.detailSelection === id
      if (
        unit.kind === "reasoning" &&
        (model.blocks[unit.block] as Extract<TranscriptBlock, { _tag: "Reasoning" }>).expanded !== true
      )
        continue
      newBlockGap()
      const start = line
      if (unit.kind === "entry") renderEntryBody(unit.entry)
      else if (unit.kind === "reasoning") renderReasoningBody(unit.block, selected)
      else if (unit.kind === "childAgent")
        renderChildAgentBody(model.blocks[unit.block] as Extract<TranscriptBlock, { _tag: "ChildAgent" }>)
      else if (unit.kind === "diff") renderDiffBody(unit.block, selected)
      else if (unit.kind === "block") renderPlainBlock(unit.block)
      else if (unit.group === "explore") renderExploreBody(toolUnitsFor(model, unit.blocks), selected)
      else if (unit.group === "edit") renderEditBody(toolUnitsFor(model, unit.blocks), unit.diffs, selected)
      else if (unit.group === "shell") renderShellBody(toolUnitsFor(model, unit.blocks), selected)
      else for (const toolUnit of toolUnitsFor(model, unit.blocks)) renderOtherToolBody(toolUnit, selected)
      ranges.push({
        start,
        end: line,
        unit: id,
        expandable,
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
    }
    for (const draft of model.toolCallDrafts as ReadonlyArray<{ id: string; name?: string; text: string }>) {
      newBlockGap()
      const start = line
      const kind = toolKind(draft.name ?? "")
      if (kind === "shell") {
        const command = /"(?:command|cmd|script)"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(draft.text)?.[1] ?? ""
        append(dim(fg(colors.text)("$ ")))
        append(fg(colors.text)(command.replace(/\\n/g, " ")))
        append(dim(fg(colors.text)(" …")))
      } else if (kind === "edit") {
        const path = /"(?:path|file_path|file)"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(draft.text)?.[1]
        append(fg(colors.blue)(spinnerFrame))
        append(fg(colors.text)(" Editing"))
        append(dim(fg(colors.text)(` ${path ?? "…"}`)))
        append(dim(fg(colors.text)(" …")))
        const tail = draft.text.split("\n").slice(-6).join("\n")
        if (tail.length > 0) {
          append(fg(colors.text)("\n"))
          append(dim(fg(colors.text)(tail.slice(-Math.max(1, model.width * 6)))))
        }
      } else {
        append(fg(colors.blue)(spinnerFrame))
        append(fg(colors.text)(` Running tool ${draft.name ?? "…"}`))
        append(dim(fg(colors.text)(" …")))
      }
      ranges.push({ start, end: line, unit: `draft:${draft.id}`, expandable: false })
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
}

interface TranscriptRenderableRecord {
  readonly key: string
  revision: string
  readonly renderable: TextRenderable
}

interface TranscriptRenderableDescriptor {
  readonly key: string
  readonly revision: string
  readonly content: StyledText
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
  readonly toolCallDrafts: Model["toolCallDrafts"]
  readonly detailSelection: Model["detailSelection"]
  readonly permissionSelection: number
  readonly width: number
  readonly windowEnd: number
}

const mouseSequencePattern = new RegExp(`^(?:${String.fromCharCode(27)}?\\[)?<?\\d+(?:;\\d+)*[Mm]?$`)

const cutoutBackground = (renderer: CliRenderer): RGBA => {
  const background: unknown = Reflect.get(renderer, "backgroundColor")
  return background instanceof RGBA && background.a > 0 ? RGBA.defaultBackground(background) : RGBA.defaultBackground()
}

class SidebarScrollBoxRenderable extends ScrollBoxRenderable {
  onWindowChanged: (() => void) | undefined

  override get scrollTop(): number {
    return super.scrollTop
  }

  override set scrollTop(value: number) {
    super.scrollTop = value
    this.onWindowChanged?.()
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
  private reasoningFlash = false
  private reasoningFlashTimer: Fiber.Fiber<void> | undefined
  private lastReasoningEffort: string | undefined
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
  private readonly changedFilesBefore: BoxRenderable
  private readonly changedFilesAfter: BoxRenderable
  private sidebarRowsSource: unknown
  private sidebarRowsView: "changed" | "workspace" | undefined
  private sidebarRowsWidth = 0
  private sidebarWindowStart = -1
  private sidebarWindowEnd = -1
  private sidebarWindowHoveredRow: number | undefined
  private scrollProgrammatic = false
  private scrollFramePending = false
  private loaderPhase = 0
  private loaderTimer: Fiber.Fiber<void> | undefined
  private transcriptViewportRows = 0
  private transcriptWindowEnd = 0
  private transcriptWindowThread: string | undefined
  private transcriptAnchorFrame: (() => void) | undefined
  private transcriptAnchorScrollBy = 0
  private pendingTranscriptAnchor: PendingTranscriptAnchor | undefined
  private scrollbarSyncing = false
  private scrollGeneration = 0
  private destroyed = false

  constructor(
    private readonly renderer: CliRenderer,
    private readonly handlers: Handlers,
    private readonly options: SurfaceOptions = {},
  ) {
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
      onMouseScroll: () => this.queueTranscriptScroll(() => this.handleTranscriptScroll()),
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
        this.queueTranscriptScroll(() => this.reportTranscriptScroll())
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
      flexShrink: 0,
      visible: false,
    })
    this.queueText = new TextRenderable(renderer, { content: "", wrapMode: "word", selectable: false })
    this.queueHint = new TextRenderable(renderer, {
      content: "",
      position: "absolute",
      bottom: 0,
      right: 1,
      zIndex: 10,
      selectable: false,
    })
    this.queueBox.add(this.queueText)
    this.queueBox.add(this.queueHint)
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
      cursorStyle: { style: "block", blinking: true },
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
      cursorStyle: { style: "block", blinking: true },
    })
    this.sidebar = new TextRenderable(renderer, {
      content: "",
      width: threadSidebarWidth,
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
      onMouseScroll: () => queueMicrotask(() => this.refreshSidebarWindow()),
    })
    this.changedFilesBox.onWindowChanged = () => this.refreshSidebarWindow()
    this.changedFilesBefore = new BoxRenderable(renderer, { height: 0, flexShrink: 0 })
    this.changedFilesText = new TextRenderable(renderer, {
      content: "",
      fg: colors.text,
      selectable: false,
      wrapMode: "none",
    })
    this.changedFilesAfter = new BoxRenderable(renderer, { height: 0, flexShrink: 0 })
    this.changedFilesBox.add(this.changedFilesBefore)
    this.changedFilesBox.add(this.changedFilesText)
    this.changedFilesBox.add(this.changedFilesAfter)
    this.changedFilesBox.verticalScrollBar.on?.("change", () => this.refreshSidebarWindow())
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
    if (!mapped.ctrl && !mapped.alt && !mapped.meta && mapped.name === "pageup") {
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
  private shiftTranscriptWindow(delta: number, preserveAnchor: boolean, scrollBy = 0): boolean {
    const model = this.model
    if (model === undefined || model.items.length <= maxMountedTranscriptEntries) return false
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
    if (this.atTranscriptBottom()) this.handlers.scrollFollow?.()
    else this.handlers.scroll?.(this.transcriptScroll.scrollTop)
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
    queueMicrotask(() => {
      if (this.destroyed || generation !== this.scrollGeneration) return
      action()
    })
  }
  private anchorTranscriptAfterLayout(): void {
    queueMicrotask(() => {
      if (this.model === undefined) return
      this.syncTranscriptScrollbar()
    })
  }
  private followTranscriptAfterLayout(): void {
    if (this.scrollFramePending) return
    this.scrollFramePending = true
    queueMicrotask(() => {
      this.scrollFramePending = false
      if (this.model?.scrollFollow !== true) return
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
      if (event.bytes.length > 0)
        this.handlers.pasteImage?.(mediaType === undefined ? { bytes: event.bytes } : { bytes: event.bytes, mediaType })
      return
    }
    const text = stripAnsiSequences(decodePasteBytes(event.bytes))
    if (text.length === 0) return
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
  private readonly onResize = (width: number, height: number) => this.handlers.resize(width, height)
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
      const existing = this.transcriptRecords.get(descriptor.key)
      if (existing !== undefined) {
        if (existing.revision !== descriptor.revision) {
          existing.revision = descriptor.revision
          existing.renderable.content = descriptor.content
        }
        existing.renderable.onMouseDown = descriptor.onMouseDown
        return existing
      }
      const renderable = new TextRenderable(this.renderer, {
        content: descriptor.content,
        wrapMode: "word",
        selectable: true,
      })
      renderable.onMouseDown = descriptor.onMouseDown
      const record = { key: descriptor.key, revision: descriptor.revision, renderable }
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
      previous.toolCallDrafts !== input.toolCallDrafts ||
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
      this.sidebarWindowStart = -1
      this.sidebarWindowEnd = -1
    }
    this.refreshSidebarWindow()
  }
  private refreshSidebarWindow(force = false): void {
    if (!this.changedFilesBox.visible) return
    const viewportRows = Math.max(1, this.changedFilesBox.viewport.height || (this.model?.height ?? 1) - 2)
    const scrollTop = Math.min(
      Math.max(0, Math.floor(this.changedFilesBox.scrollTop)),
      Math.max(0, this.changedRows.length - viewportRows),
    )
    const start = Math.max(0, scrollTop - 4)
    const end = Math.min(this.changedRows.length, scrollTop + viewportRows + 4)
    if (
      !force &&
      start === this.sidebarWindowStart &&
      end === this.sidebarWindowEnd &&
      this.changedFilesHoveredRow === this.sidebarWindowHoveredRow
    )
      return
    this.sidebarWindowStart = start
    this.sidebarWindowEnd = end
    this.sidebarWindowHoveredRow = this.changedFilesHoveredRow
    this.changedFilesBefore.height = start
    this.changedFilesAfter.height = Math.max(0, this.changedRows.length - end)
    this.changedFilesText.content = renderFileRows(
      this.changedRows.slice(start, end),
      this.changedFilesHoveredRow === undefined ? undefined : this.changedFilesHoveredRow - start,
    )
  }
  private welcomeWidthFor(model: Model): number {
    const sidebarReady = model.changedFilesOpen
      ? isReady(model.changedFiles)
      : model.workspaceFilesOpen
        ? isReady(model.filePicker.items)
        : false
    const visible = (model.changedFilesOpen || model.workspaceFilesOpen) && sidebarReady && !isNarrow(model)
    const contentWidth = Math.max(
      1,
      model.width - (visible ? model.sidebarWidth : 0) - (model.threadSidebar.open ? threadSidebarWidth : 0),
    )
    return Math.max(1, contentWidth - spacing.transcript * 2)
  }
  showToast(message: string, color: ColorInput = colors.green): void {
    this.toast.content = new StyledText([fg(color)("✓ "), fg(colors.text)(message)])
    this.toastBox.borderColor = color
    this.toastBox.width = message.length + 6
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
    const transcriptAnchor = preserveTranscriptAnchor ? this.captureTranscriptAnchor() : undefined
    const previousModel = this.model
    const previousItems = previousModel?.items.length ?? 0
    if (this.transcriptWindowThread !== model.currentThreadId) {
      if (this.transcriptAnchorFrame !== undefined) this.renderer.off(CliRenderEvents.FRAME, this.transcriptAnchorFrame)
      this.transcriptAnchorFrame = undefined
      this.pendingTranscriptAnchor = undefined
      this.transcriptAnchorScrollBy = 0
      this.transcriptWindowThread = model.currentThreadId
      this.transcriptWindowEnd = model.items.length
    } else if (preserveTranscriptAnchor)
      this.transcriptWindowEnd = Math.min(
        model.items.length,
        this.transcriptWindowEnd + Math.max(0, model.items.length - previousItems),
      )
    else if (model.scrollFollow || this.transcriptWindowEnd === 0) this.transcriptWindowEnd = model.items.length
    else this.transcriptWindowEnd = Math.min(this.transcriptWindowEnd, model.items.length)
    this.model = model
    this.queueHint.bg = cutoutBackground(this.renderer)
    this.modeLabel.bg = cutoutBackground(this.renderer)
    this.workspaceLabel.bg = cutoutBackground(this.renderer)
    this.statusLabel.bg = cutoutBackground(this.renderer)
    if (model.shortcutsOpen) this.setComposerResizePointer(false)
    const inputHeight = composerHeight(model)
    const renderedInputHeight = model.shortcutsOpen ? Math.min(model.height - 4, spacing.inputHeight + 12) : inputHeight
    const sidebarReady = model.changedFilesOpen
      ? isReady(model.changedFiles)
      : model.workspaceFilesOpen
        ? isReady(model.filePicker.items)
        : false
    const sidebarVisible = (model.changedFilesOpen || model.workspaceFilesOpen) && sidebarReady && !isNarrow(model)
    const sidebarWidth = sidebarVisible ? model.sidebarWidth : 0
    const contentWidth = Math.max(1, model.width - sidebarWidth - (model.threadSidebar.open ? threadSidebarWidth : 0))
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
      const renderModel = sidebarWidth === 0 && !model.threadSidebar.open ? model : { ...model, width: contentWidth }
      const transcriptInput = {
        entries: renderModel.entries,
        blocks: renderModel.blocks,
        items: renderModel.items,
        toolCallDrafts: renderModel.toolCallDrafts,
        detailSelection: renderModel.detailSelection,
        permissionSelection: renderModel.permissionSelection,
        width: renderModel.width,
        windowEnd: this.transcriptWindowEnd,
      }
      if (this.transcriptChanged(transcriptInput)) {
        const built = buildTranscript(
          boundedTranscriptModel(renderModel, this.transcriptWindowEnd),
          model.busy ? spinnerFrames[this.loaderPhase % spinnerFrames.length]! : idleSpinnerFrame,
        )
        const styledLines = splitStyledLines(built.styled)
        const descriptors: Array<TranscriptRenderableDescriptor> = []
        for (const range of built.ranges.slice(-maxMountedTranscriptEntries)) {
          const headerContent = new StyledText(styledLines[range.start] ?? [])
          descriptors.push({
            key: `${range.unit}:header`,
            revision: JSON.stringify(headerContent.chunks),
            content: headerContent,
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
            })
          for (const [index, target] of (range.targets ?? []).entries()) {
            const content = new StyledText([fg(colors.blue)(`  ${target.path}`)])
            descriptors.push({
              key: `${range.unit}:path:${index}`,
              revision: JSON.stringify({ target, chunks: content.chunks }),
              content,
              onMouseDown: (event: MouseEvent) => {
                if (event.button !== 0) return
                event.stopPropagation()
                this.handlers.openPath?.(target)
              },
            })
          }
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
    const queue = model.queue as ReadonlyArray<import("./view-state").QueueItem>
    this.queueBox.visible = queue.length > 0
    this.queueBox.height = Math.min(
      Math.max(3, model.height - renderedInputHeight - 2),
      Math.max(3, queue.length + queue.reduce((total, item) => total + (item.attachments?.length ?? 0), 0) + 2),
    )
    this.queueText.content = new StyledText(
      queue.flatMap((item, index) => {
        const label = `${item.prompt}${item.attachments?.map((path) => `\n  ▧ ${path}`).join("") ?? ""}`
        const chunk = item.id === model.queueSelection ? bold(fg(colors.text)(label)) : fg(colors.subtle)(label)
        return index === queue.length - 1 ? [chunk] : [chunk, fg(colors.text)("\n")]
      }),
    )
    this.queueHint.content = new StyledText([
      fg(colors[model.mode])(" Enter"),
      dim(fg(colors.text)(" to steer")),
      dim(fg(colors.text)(" · ")),
      fg(colors[model.mode])("Backspace"),
      dim(fg(colors.text)(" to dequeue ")),
    ])
    this.queueHint.visible = queue.length > 0
    this.inputBox.borderColor = colors.text
    const costText = model.costUsd !== undefined ? formatCost(model.costUsd) : model.busy ? "$····" : ""
    this.inputBox.title = ""
    const modeText = `${model.mode}${effortSuperscript(model)}`
    const modeChunks: Array<TextChunk> = []
    if (costText.length > 0) {
      modeChunks.push(dim(fg(colors.text)(` ${costText} `)))
      modeChunks.push(fg(colors.text)("─"))
    }
    modeChunks.push(fg(colors.text)(" "))
    if (model.fastMode) modeChunks.push(fg(colors.amber)("↯"))
    modeChunks.push(fg(colors[model.mode])(modeText))
    modeChunks.push(fg(colors.text)(" "))
    this.modeLabel.right = sidebarWidth + 2
    this.modeLabel.width = modeChunks.reduce((total, chunk) => total + stringWidth(chunk.text), 0)
    this.modeLabel.content = new StyledText(modeChunks)
    const workspaceTitle = isNarrow(model)
      ? ""
      : ` ${compactWorkspace(model.workspace)}${model.branch === undefined ? "" : ` (${model.branch})`} `
    const panelLoadingLabel = panelLoading(model)
    if (model.busy || panelLoadingLabel !== undefined) {
      const statusName = model.busy ? (model.busyStatus ?? "Waiting") : panelLoadingLabel!
      this.inputBox.bottomTitle = ""
      this.statusLabel.content = new StyledText([
        fg(colors.text)(" "),
        fg(colors.blue)(loaderFrame(statusName, this.loaderPhase)),
        dim(fg(colors.text)(` ${statusName} `)),
      ])
    } else {
      this.inputBox.bottomTitle = ""
      if (this.lastReasoningEffort !== undefined && this.lastReasoningEffort !== model.reasoningEffort) {
        this.cancelTimer(this.reasoningFlashTimer)
        this.reasoningFlash = true
        this.reasoningFlashTimer = this.delayed(2500, () => {
          this.reasoningFlash = false
          this.reasoningFlashTimer = undefined
          this.renderer.requestRender()
        })
      }
      this.statusLabel.content =
        this.reasoningFlash && !isNarrow(model)
          ? new StyledText([dim(fg(colors.text)(` reasoning ${model.reasoningEffort} `))])
          : ""
    }
    this.lastReasoningEffort = model.reasoningEffort
    this.workspaceLabel.right = sidebarWidth + 2
    this.workspaceLabel.content = new StyledText([dim(fg(colors.text)(workspaceTitle))])
    this.inputBox.height = renderedInputHeight
    this.modeLabel.top = model.height - renderedInputHeight - (queue.length > 0 ? this.queueBox.height : 0)
    this.transcriptViewportRows = Math.max(
      1,
      model.height - renderedInputHeight - (queue.length > 0 ? this.queueBox.height : 0),
    )
    this.transcriptScroll.content.minHeight = this.transcriptViewportRows
    this.input.visible = model.shortcutsOpen
    this.input.content = model.shortcutsOpen ? shortcutsContent(model, Math.max(1, contentWidth - 4)) : ""
    this.composerEditor.visible = !model.shortcutsOpen
    this.composerEditor.height = Math.max(1, renderedInputHeight - 2)
    this.composerEditor.sync(displayInput(model), displayCursorOffset(model))
    this.sidebar.visible = model.threadSidebar.open
    this.sidebar.content = renderSidebar(model, spinnerFrames[this.loaderPhase % spinnerFrames.length]!)
    this.changedFilesBox.visible = sidebarVisible
    if (this.changedFilesBox.visible) {
      this.changedFilesBox.width = Math.max(8, model.sidebarWidth - 2)
      this.changedFilesBox.title = model.changedFilesOpen
        ? ` Changed files (${readyOr(model.changedFiles, []).length}) `
        : ` Files (${readyOr(model.filePicker.items, []).length}) `
      this.changedFilesBox.titleAlignment = "left"
      this.refreshSidebarRows(model)
    } else {
      this.changedFilesHoveredRow = undefined
    }
    this.transcriptScroll.stickyScroll = model.scrollFollow
    this.anchorTranscriptAfterLayout()
    if (preserveTranscriptAnchor) {
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
    else if (model.scrollFollow) this.followTranscriptAfterLayout()
    else if (Math.abs(this.transcriptScroll.scrollTop - model.scrollOffset) > 1) {
      this.scrollProgrammatic = true
      this.transcriptScroll.scrollTop = model.scrollOffset
      this.scrollProgrammatic = false
    }
    const loaderActive =
      model.busy ||
      panelLoadingLabel !== undefined ||
      (model.threadSidebar.open &&
        (model.threads as ReadonlyArray<ThreadItem>).some((thread) => thread.status !== "idle"))
    if (this.options.animate !== false && loaderActive && this.loaderTimer === undefined) {
      this.loaderTimer = this.repeated(spinnerInterval, () => {
        this.loaderPhase = (this.loaderPhase + 1) % spinnerFrames.length
        const current = this.model
        if (current !== undefined) {
          const label = current.busy ? (current.busyStatus ?? "Waiting") : panelLoading(current)
          if (label !== undefined) {
            this.statusLabel.content = new StyledText([
              fg(colors.text)(" "),
              fg(colors.blue)(loaderFrame(label, this.loaderPhase)),
              dim(fg(colors.text)(` ${label} `)),
            ])
          }
          if (current.threadSidebar.open)
            this.sidebar.content = renderSidebar(current, spinnerFrames[this.loaderPhase % spinnerFrames.length]!)
        }
        this.renderer.requestRender()
      })
    } else if ((this.options.animate === false || !loaderActive) && this.loaderTimer !== undefined) {
      this.cancelTimer(this.loaderTimer)
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
    this.overlayEditor.visible = false
    this.paletteBox.bottomTitle = ""
    let cursorEditor: ProjectedEditorRenderable | undefined =
      model.shortcutsOpen || model.threadSidebar.focused ? undefined : this.composerEditor
    if (overlay === "palette") {
      const results = filter(model.palette.query)
      const boxWidth = Math.max(20, Math.min(80, model.width - 4))
      const boxHeight = Math.min(Math.max(1, composerTop), results.length + 5)
      this.paletteBox.width = boxWidth
      this.paletteBox.height = boxHeight
      this.paletteBox.left = Math.max(0, Math.floor((model.width - boxWidth) / 2))
      this.paletteBox.top = Math.max(0, Math.floor((composerTop - boxHeight) / 2))
      this.paletteBox.title = " Command Palette "
      this.paletteBox.titleColor = colors.amber
      this.paletteBox.titleAlignment = "left"
      this.palette.content = paletteContent(model, results, boxWidth - 4, boxHeight - 2)
      this.syncOverlayEditor(`> ${model.palette.query}`, 2 + model.palette.query.length, 0, boxHeight - 2, boxWidth - 4)
      cursorEditor = this.overlayEditor
    } else if (overlay === "modes") {
      const boxWidth = Math.min(58, contentWidth)
      const boxHeight = Math.min(9, Math.max(3, composerTop))
      this.paletteBox.width = boxWidth
      this.paletteBox.height = boxHeight
      this.paletteBox.left = Math.max(0, contentWidth - boxWidth)
      this.paletteBox.top = Math.max(0, composerTop - boxHeight)
      this.paletteBox.title = ""
      this.paletteBox.bottomTitle = " ←→ turn · esc"
      this.paletteBox.bottomTitleAlignment = "right"
      this.palette.content = modePickerContent(model, boxWidth - 4)
      cursorEditor = undefined
    } else if (overlay === "files") {
      const entries = filteredFiles(model).map((file) => `@${file}`)
      const maxRows = Math.max(1, Math.min(20, composerTop - 1))
      const visibleEntries = entries.slice(0, Math.max(1, maxRows))
      const innerWidth = Math.max(...visibleEntries.map((row) => row.length), 19)
      const boxWidth = Math.min(innerWidth + 4, model.width - 4)
      const boxHeight = visibleEntries.length + 2
      this.paletteBox.width = boxWidth
      this.paletteBox.height = boxHeight
      this.paletteBox.left = 2
      this.paletteBox.top = Math.max(0, composerTop - boxHeight)
      this.paletteBox.title = ""
      this.palette.content = filePickerContent(model, visibleEntries, boxWidth - 4)
    } else if (overlay === "threads") {
      const overlayWidth = Math.max(10, Math.min(140, model.width - 4))
      const overlayHeight = Math.max(6, composerTop - 2)
      this.paletteBox.width = overlayWidth
      this.paletteBox.height = overlayHeight
      this.paletteBox.left = Math.max(0, Math.floor((model.width - overlayWidth) / 2))
      this.paletteBox.top = Math.max(0, composerTop - overlayHeight)
      this.paletteBox.title = model.threadSwitcher.kind === "mention" ? " Mention Thread " : " Switch Thread "
      this.paletteBox.titleAlignment = "left"
      this.paletteBox.bottomTitle = " Opt+W/Ctrl+T all workspaces · Esc close "
      this.paletteBox.bottomTitleAlignment = "right"
      this.palette.content = threadSwitcherContent(model, overlayWidth - 4, overlayHeight - 2)
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
    if (editor === this.composerEditor) {
      this.overlayEditor.blur()
      this.composerEditor.focus()
      return
    }
    if (editor === this.overlayEditor) {
      this.composerEditor.blur()
      this.overlayEditor.focus()
      return
    }
    this.composerEditor.blur()
    this.overlayEditor.blur()
  }

  destroy(): void {
    this.destroyed = true
    this.scrollGeneration += 1
    if (this.transcriptAnchorFrame !== undefined) this.renderer.off(CliRenderEvents.FRAME, this.transcriptAnchorFrame)
    this.transcriptAnchorFrame = undefined
    this.transcriptAnchorScrollBy = 0
    this.pendingTranscriptAnchor = undefined
    this.cancelTimer(this.loaderTimer)
    this.loaderTimer = undefined
    this.cancelTimer(this.welcomeTimer)
    this.welcomeTimer = undefined
    this.cancelTimer(this.toastTimer)
    this.toastTimer = undefined
    this.cancelTimer(this.reasoningFlashTimer)
    this.reasoningFlashTimer = undefined
    this.cancelTimer(this.junkTimer)
    this.junkTimer = undefined
    this.junkBuffer = []
    this.composerEditor.blur()
    this.overlayEditor.blur()
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
  [
    ["Ctrl+S", "switch modes"],
    ["Opt+D", "toggle reasoning effort"],
  ],
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
  ["Cmd+Shift+E", "archive selected thread"],
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
  low: "GPT-5.6 Terra low",
  medium: "GPT-5.6 Luna medium",
  high: "GPT-5.6 Sol high",
  ultra: "Fable 5 high",
} as const
const modeOracleLabel = {
  low: "GPT-5.6 Sol high",
  medium: "GPT-5.6 Sol high",
  high: "Fable 5 high",
  ultra: "Fable 5 high",
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

const clipStyledLine = (line: ReadonlyArray<TextChunk>, width: number): Array<TextChunk> => {
  const out: Array<TextChunk> = []
  let used = 0
  for (const chunk of line) {
    if (used >= width) break
    const text = chunk.text.length > width - used ? chunk.text.slice(0, width - used) : chunk.text
    out.push({ ...chunk, text })
    used += text.length
  }
  return out
}

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
  if (!isReady(model.threadPreview) || selected === undefined) return undefined
  const preview = model.threadPreview.value
  if (preview.threadId !== selected.id || preview.turns.length === 0) return undefined
  let previewModel: Model = { ...initial(model.workspace, model.mode), width: Math.max(8, width), height: 200 }
  preview.turns.forEach((turn, index) => {
    previewModel = projectTurn(previewModel, `preview-${index}`, turn.prompt, turn.events as ReadonlyArray<Event>)
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
    const title = thread.title.length > titleWidth ? `${thread.title.slice(0, titleWidth - 1)}…` : thread.title
    const leftText = `  ${title}`
    const padding = Math.max(1, width - leftText.length - rightWidth - 1)
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

const previewBoxRows = (model: Model, width: number, height: number): ReadonlyMap<number, ReadonlyArray<TextChunk>> => {
  const rows = new Map<number, ReadonlyArray<TextChunk>>()
  if (width < 8 || height < 4) return rows
  const inner = width - 2
  const preview = selectedThreadMetadata(model)
  const contentWidth = Math.max(1, inner - 3)
  const contentRows = Math.max(1, height - 4)
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
        fg(colors.muted)("│ "),
        ...line,
        fg(colors.text)(" ".repeat(Math.max(0, contentWidth - textWidth))),
        scrollable ? fg(colors.muted)(contentRow - 2 === thumb ? "█" : "│") : fg(colors.text)(" "),
        fg(colors.muted)("│"),
      ])
    })
  } else {
    const status = isLoading(model.threadPreview) ? "Loading preview" : "No preview"
    const statusLeft = Math.max(0, Math.floor((inner - status.length) / 2))
    rows.set(2, [
      fg(colors.muted)("│"),
      fg(colors.text)(" ".repeat(statusLeft)),
      dim(fg(colors.text)(status)),
      fg(colors.text)(" ".repeat(Math.max(0, inner - statusLeft - status.length))),
      fg(colors.muted)("│"),
    ])
    if (preview !== undefined) {
      const details = [
        preview.title,
        preview.workspace,
        [preview.archived ? "archived" : "", preview.unread ? "unread" : "", preview.status]
          .filter((value) => value.length > 0)
          .join(" · "),
      ].filter((value) => value.length > 0)
      details.forEach((line, index) => {
        const visible = truncateToWidth(line, contentWidth)
        rows.set(height - 1 - details.length + index, [
          fg(colors.muted)("│ "),
          fg(colors.text)(visible),
          fg(colors.text)(" ".repeat(Math.max(0, contentWidth - stringWidth(visible) + 1))),
          fg(colors.muted)("│"),
        ])
      })
    }
  }
  for (let row = 2; row < height - 1; row += 1)
    if (!rows.has(row))
      rows.set(row, [fg(colors.muted)("│"), fg(colors.text)(" ".repeat(inner)), fg(colors.muted)("│")])
  rows.set(height - 1, [fg(colors.muted)(`╰${"─".repeat(inner)}╯`)])
  return rows
}

const threadSwitcherContent = (model: Model, innerWidth: number, innerHeight: number): StyledText => {
  const horizontal = model.width >= 120
  const showPreview = horizontal || innerHeight >= 9
  const layoutWidth = Math.max(8, innerWidth - 1)
  const listWidth = threadSwitcherListWidth(model, innerWidth)
  const listHeight = horizontal
    ? innerHeight
    : showPreview
      ? Math.max(5, Math.min(innerHeight - 4, Math.floor(innerHeight * 0.42)))
      : innerHeight
  const previewWidth = horizontal ? Math.max(8, layoutWidth - listWidth - 2) : layoutWidth
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
        const used = listRow.reduce((total, chunk) => total + chunk.text.length, 0)
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
  const layoutWidth = Math.max(8, innerWidth - 1)
  return model.width >= 120 ? Math.max(8, Math.floor((layoutWidth - 2) / 2)) : layoutWidth
}

const filePickerContent = (model: Model, entries: ReadonlyArray<string>, innerWidth: number): StyledText => {
  const chunks: Array<TextChunk> = []
  entries.forEach((entry, index) => {
    if (index > 0) chunks.push(fg(colors.text)("\n"))
    const marker = /^@{1,2}/.exec(entry)?.[0] ?? ""
    const rest = entry.slice(marker.length)
    const clipped = rest.slice(0, Math.max(0, innerWidth - marker.length))
    if (index === model.filePicker.selected) {
      chunks.push(bg(colors.muted)(fg(colors.teal)(marker)))
      chunks.push(bg(colors.muted)(fg(colors.text)(clipped)))
      chunks.push(
        bg(colors.muted)(fg(colors.text)(" ".repeat(Math.max(0, innerWidth - marker.length - clipped.length)))),
      )
    } else {
      chunks.push(fg(colors.teal)(marker))
      chunks.push(fg(colors.text)(clipped))
    }
  })
  if (chunks.length === 0)
    chunks.push(dim(fg(colors.text)(isLoading(model.filePicker.items) ? "Loading files" : "no matches")))
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

const effortLevels = ["low", "medium", "high", "xhigh"] as const
const effortSuperscripts = ["", "²", "³", "⁴"] as const

const effortSuperscript = (model: Model): string => {
  if (model.reasoningEffort === defaultReasoningEffort(model.mode)) return ""
  const index = effortLevels.indexOf(model.reasoningEffort)
  return index <= 0 ? "" : effortSuperscripts[index]!
}

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
  Effect.runPromise(
    Effect.tryPromise(() =>
      createCliRenderer({
        screenMode: "alternate-screen",
        exitOnCtrlC: false,
        useMouse: true,
        enableMouseMovement: true,
      }),
    ).pipe(
      Effect.map((renderer) => {
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
          } catch (cause) {
            releaseTerminal()
            throw cause
          }
        }
        try {
          handlers.resize(renderer.terminalWidth, renderer.terminalHeight)
          surface = new Surface(renderer, handlers)
          return { surface, releaseTerminal, suspendTerminal, resumeTerminal }
        } catch (cause) {
          releaseTerminal()
          throw cause
        }
      }),
    ),
  )
