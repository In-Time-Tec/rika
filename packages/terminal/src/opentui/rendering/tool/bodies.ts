import { bold, dim, fg, italic, strikethrough, StyledText, type TextChunk } from "@opentui/core"
import stringWidth from "string-width"
import type { Model } from "../../../state/model"
import { decodeTranscriptBlocks } from "../../../state/transcript/model"
import { colors } from "../../../presentation/terminal/theme"
import { escapeControlCharacters, plural } from "../../../presentation/terminal/format"
import { highlightShellCommand, wrapStyledLine } from "../text-adapter"
import {
  renderDiffStyled,
  renderPartialDiffStyled,
  renderPierreDiff,
  renderReadFile,
  renderToolSummary,
} from "../diff-text-adapter"
import { transcriptWrapWidth } from "../transcript/window"
import { aggregateRowStatus, rowStatusIcon, wrapTextToWidth, wrapBodyText, type RowStatus } from "../window"
import {
  inputString,
  toolInputValue,
  diffCounts,
  shellCommandText,
  shellExitCode,
  shellMetadata,
  exploreChildLabel,
  type ToolUnit,
} from "./detail"
import { toolDetails } from "../../../presentation/transcript/tool/detail"
import { isToolOutputDisplayed } from "../../../presentation/transcript/agent-response"
import { isExpandableBody, readFileBody, toolBody, toolResultText } from "../../../presentation/transcript/tool/body"
import type { UnitLineRange } from "../transcript/window"

export interface ToolBodyContext {
  readonly model: Model
  readonly spinnerFrame: string
  readonly append: (chunk: TextChunk) => void
  readonly appendAll: (styled: StyledText) => void
  readonly line: () => number
  readonly mark: () => number
  readonly disclose: (from: number, expanded: boolean) => void
  readonly nestedRanges: Array<UnitLineRange>
  readonly rowExpanded: (id: string) => boolean
  readonly rowExplicitlyCollapsed: (id: string) => boolean
  readonly highlight: (text: string) => void
  readonly statusIcon: (status: RowStatus) => TextChunk
}

const exploreBodyState = (units: ReadonlyArray<ToolUnit>) => {
  const status = aggregateRowStatus(units.map((unit) => unit.block.status))
  const running = status === "running"
  const counters = new Map<string, number>()
  for (const unit of units) {
    const counter = unit.block.presentation.counter ?? (unit.kind === "read" ? "file" : "search")
    counters.set(counter, (counters.get(counter) ?? 0) + 1)
  }
  const counts = [...counters].map(([counter, count]) => plural(count, counter)).join(", ")
  return { status, running, subject: counts.length > 0 ? counts : "workspace" }
}

const editBodyState = (model: Model, units: ReadonlyArray<ToolUnit>, diffs: ReadonlyArray<number>) => {
  const status = aggregateRowStatus(units.map((unit) => unit.block.status))
  const failed = status === "failed" || status === "rejected" || status === "unknown"
  const running = status === "running"
  const cancelled = status === "cancelled"
  const paths = [
    ...new Set(
      units.flatMap((unit) =>
        unit.block.files.length > 0
          ? unit.block.files.map((file) => file.path)
          : [inputString(toolInputValue(unit.block.input), ["path", "file_path", "file"]) ?? ""],
      ),
    ),
  ]
  const files = units.flatMap((unit) => unit.block.files)
  let added = files.reduce((total, file) => total + file.additions, 0)
  let removed = files.reduce((total, file) => total + file.deletions, 0)
  for (const diffIndex of diffs) {
    const diff = decodeTranscriptBlocks(model.blocks)[diffIndex]
    if (diff?._tag !== "Diff") continue
    const [diffAdded, diffRemoved] = diffCounts(diff.patch)
    added += diffAdded
    removed += diffRemoved
  }
  const creates = diffs.length === 0 && files.length > 0 && files.every((file) => file.kind === "add")
  let verb = running ? "Editing" : "Edited"
  if (creates) verb = running ? "Creating" : "Created"
  else if (paths.length === 1 && units.length === 1)
    verb = running ? units[0]!.block.presentation.activeLabel : units[0]!.block.presentation.completeLabel
  return {
    status,
    failed,
    running,
    cancelled,
    files,
    added,
    removed,
    verb,
    label: paths.length === 1 ? paths[0]! : plural(paths.length, "file"),
  }
}

const shellGroupState = (units: ReadonlyArray<ToolUnit>) => ({
  status: aggregateRowStatus(units.map((unit) => unit.block.status)),
  failedCount: units.filter(
    (unit) => unit.block.status === "failed" || unit.block.status === "rejected" || unit.block.status === "unknown",
  ).length,
  cancelledCount: units.filter((unit) => unit.block.status === "cancelled").length,
})

export const createToolBodyRenderer = (context: ToolBodyContext) => {
  const { model, spinnerFrame, append, appendAll, rowExpanded, rowExplicitlyCollapsed, highlight, statusIcon } = context
  const exploreSummary = (unit: ToolUnit) => {
    const detail = toolDetails(model, { kind: "tool", group: "explore", blocks: [unit.index], diffs: [] })[0]!
    let summary = detail.summary
    if (unit.block.presentation.action === "skill") summary = { primary: exploreChildLabel(unit) }
    else if (unit.block.presentation.action === "git-status" || unit.block.presentation.action === "status")
      summary = {
        primary: "Checked",
        secondary: ` ${unit.block.detail || unit.block.process?.processId || "workspace"}`,
      }
    return { detail, summary }
  }
  const renderExploreOutput = (unit: ToolUnit, output: string, indent: string) => {
    const file = readFileBody(unit.block)
    if (file === undefined) append(dim(fg(colors.text)(wrapBodyText(output, transcriptWrapWidth(model.width), indent))))
    else appendAll(renderReadFile(file.text, { path: file.path, width: transcriptWrapWidth(model.width), indent }))
  }
  const renderExploreChild = (unit: ToolUnit) => {
    const childId = `tool-child:${unit.block.id}`
    const childOutput = isToolOutputDisplayed(unit.block) ? toolResultText(unit.block.result) : undefined
    const childExpandable = isExpandableBody(toolBody(unit.block))
    append(fg(colors.text)("\n "))
    const rowStart = context.mark()
    const start = context.line()
    append(statusIcon(unit.block.status))
    const { detail, summary } = exploreSummary(unit)
    for (const chunk of renderToolSummary(summary, {
      leading: " ",
      underlineSecondary: detail.target !== undefined,
    })[0]!)
      append(chunk)
    const output =
      (unit.block.status === "failed" || unit.block.status === "rejected" || unit.block.status === "unknown") &&
      isToolOutputDisplayed(unit.block)
        ? toolResultText(unit.block.result)
            ?.split("\n")
            .find((value) => value.length > 0)
        : undefined
    if (output !== undefined) append(dim(fg(colors.text)(` ${output}`)))
    if (childExpandable) context.disclose(rowStart, rowExpanded(childId))
    const headerEnd = context.line()
    if (childExpandable && rowExpanded(childId)) {
      append(fg(colors.text)("\n"))
      renderExploreOutput(unit, childOutput ?? "", "    ")
    }
    const nestedRange = {
      start,
      end: context.line(),
      headerEnd,
      unit: childId,
      expandable: childExpandable,
      animated: unit.block.status === "running",
    }
    context.nestedRanges.push(detail.target === undefined ? nestedRange : { ...nestedRange, targets: [detail.target] })
  }
  const renderSingleExploreBody = (unit: ToolUnit, selected: boolean, expanded: boolean) => {
    const { detail, summary } = exploreSummary(unit)
    append(selected ? bold(statusIcon(unit.block.status)) : statusIcon(unit.block.status))
    for (const chunk of renderToolSummary(summary, {
      leading: " ",
      selected,
      underlineSecondary: detail.target !== undefined,
    })[0]!)
      append(chunk)
    const output = isToolOutputDisplayed(unit.block) ? toolResultText(unit.block.result) : undefined
    if (expanded && output !== undefined && output.length > 0) {
      append(fg(colors.text)("\n"))
      renderExploreOutput(unit, output, "  ")
    }
  }
  const renderExploreBody = (units: ReadonlyArray<ToolUnit>, selected: boolean, expanded: boolean) => {
    if (units.length === 1) {
      renderSingleExploreBody(units[0]!, selected, expanded)
      return
    }
    const { status, running, subject } = exploreBodyState(units)
    if (selected) highlight(`${rowStatusIcon(status, spinnerFrame)} ${running ? "Exploring" : "Explored"} ${subject}`)
    else {
      append(statusIcon(status))
      for (const chunk of renderToolSummary(
        { primary: running ? "Exploring" : "Explored", secondary: ` ${subject}` },
        { leading: " " },
      )[0]!)
        append(chunk)
    }
    if (expanded) for (const unit of units) renderExploreChild(unit)
  }
  type EditFile = ReturnType<typeof editBodyState>["files"][number]
  const renderSingleEditFile = (file: EditFile) => {
    if (file.patch.length === 0) return
    append(fg(colors.text)("\n"))
    appendAll(
      renderPierreDiff(file.patch, { width: transcriptWrapWidth(model.width) }) ??
        (file.preview ? renderPartialDiffStyled(file.patch, { width: transcriptWrapWidth(model.width) }) : undefined) ??
        renderDiffStyled(file.patch, { width: transcriptWrapWidth(model.width) }),
    )
  }
  const editFileExpanded = (file: EditFile, running: boolean): boolean =>
    rowExpanded(`file:${file.key}`) || (running && !rowExplicitlyCollapsed(`file:${file.key}`))
  const editFileStatus = (file: EditFile, running: boolean, cancelled: boolean): RowStatus => {
    if (cancelled && file.status === "running") return "cancelled"
    return running && file.status === "running" ? "running" : file.status
  }
  const renderEditFileChild = (file: EditFile, running: boolean, cancelled: boolean) => {
    append(fg(colors.text)("\n  "))
    const rowStart = context.mark()
    const start = context.line()
    const childId = `file:${file.key}`
    const childExpanded = editFileExpanded(file, running)
    const fileRunning = running && file.status === "running"
    append(statusIcon(editFileStatus(file, running, cancelled)))
    for (const chunk of renderToolSummary(
      { primary: file.kind === "add" ? "Create" : "Edit", secondary: ` ${file.path}` },
      { leading: " ", underlineSecondary: true },
    )[0]!)
      append(chunk)
    if (file.additions > 0) append(fg(colors.green)(` +${file.additions}`))
    if (file.deletions > 0) append(fg(colors.red)(` -${file.deletions}`))
    context.disclose(rowStart, childExpanded)
    if (childExpanded && file.patch.length > 0) {
      append(fg(colors.text)("\n"))
      appendAll(
        renderPierreDiff(file.patch, { width: transcriptWrapWidth(model.width), indent: 4 }) ??
          (file.preview
            ? renderPartialDiffStyled(file.patch, { width: transcriptWrapWidth(model.width), indent: 4 })
            : undefined) ??
          renderDiffStyled(file.patch, { width: transcriptWrapWidth(model.width), indent: 4 }),
      )
    }
    context.nestedRanges.push({
      start,
      end: context.line(),
      unit: childId,
      expandable: true,
      animated: fileRunning,
      targets: [{ path: file.path }],
    })
  }
  const renderEditFiles = (state: ReturnType<typeof editBodyState>) => {
    const { files, running, cancelled } = state
    if (files.length === 1) {
      renderSingleEditFile(files[0]!)
      return
    }
    for (const file of files) renderEditFileChild(file, running, cancelled)
  }
  const renderEditDiffs = (diffs: ReadonlyArray<number>) => {
    for (const diffIndex of diffs) {
      const diff = decodeTranscriptBlocks(model.blocks)[diffIndex]
      if (diff?._tag !== "Diff") continue
      append(fg(colors.text)("\n"))
      const start = context.line()
      appendAll(
        renderPierreDiff(diff.patch, { width: transcriptWrapWidth(model.width) }) ??
          renderDiffStyled(diff.patch, { width: transcriptWrapWidth(model.width) }),
      )
      context.nestedRanges.push({
        start,
        end: context.line(),
        unit: `diff-child:${diffIndex}`,
        expandable: false,
        targets: [{ path: diff.path }],
      })
    }
  }
  const renderEditBody = (
    units: ReadonlyArray<ToolUnit>,
    diffs: ReadonlyArray<number>,
    selected: boolean,
    expanded: boolean,
  ) => {
    const state = editBodyState(model, units, diffs)
    const { status, added, removed, verb, label } = state
    append(selected ? bold(statusIcon(status)) : statusIcon(status))
    for (const chunk of renderToolSummary(
      { primary: verb, secondary: ` ${label}` },
      {
        leading: " ",
        selected,
        underlineSecondary: label !== "file" && label !== "files",
      },
    )[0]!)
      append(chunk)
    if (added > 0) append(fg(colors.green)(` +${added}`))
    if (removed > 0) append(fg(colors.red)(` -${removed}`))
    if (expanded) {
      renderEditFiles(state)
      renderEditDiffs(diffs)
    }
  }
  const shellFailureSuffix = (unit: ToolUnit): string => {
    if (unit.block.status === "failed") return ` (exit code: ${shellExitCode(unit.block) ?? 1})`
    if (unit.block.status === "rejected") return " (rejected)"
    if (unit.block.status === "cancelled") return " (cancelled)"
    if (unit.block.status === "unknown") return " (unknown)"
    return ""
  }
  const renderShellMetadata = (unit: ToolUnit, indent: string) => {
    const metadata = shellMetadata(unit.block).map(escapeControlCharacters)
    if (metadata.length === 0) return
    append(fg(colors.text)("\n"))
    append(dim(fg(colors.muted)(wrapBodyText(metadata.join(" · "), transcriptWrapWidth(model.width), indent))))
  }
  const renderShellCommand = (unit: ToolUnit, continuationIndent: string, prefixWidth: number, selected = false) => {
    const command = shellCommandText(unit.block)
    const stopped = unit.block.status === "cancelled" || unit.block.status === "rejected"
    const suffix = shellFailureSuffix(unit)
    const commandWidth = Math.max(1, transcriptWrapWidth(model.width) - prefixWidth - stringWidth(suffix))
    const highlighted = stopped ? undefined : highlightShellCommand(command)
    const sourceLines = command.split("\n")
    for (const [lineIndex, current] of sourceLines.entries()) {
      if (lineIndex > 0) {
        append(fg(colors.text)("\n"))
        append(fg(colors.text)(continuationIndent))
      }
      if (stopped) {
        append(strikethrough(fg(colors.text)(wrapTextToWidth(current, commandWidth).join(`\n${continuationIndent}`))))
        continue
      }
      for (const [rowIndex, row] of wrapStyledLine(highlighted?.[lineIndex] ?? [], commandWidth).entries()) {
        if (rowIndex > 0) {
          append(fg(colors.text)("\n"))
          append(fg(colors.text)(continuationIndent))
        }
        if (selected) append(bold(fg(colors.blue)(row.map((chunk) => chunk.text).join(""))))
        else for (const chunk of row) append(chunk)
      }
    }
    if (suffix.length > 0) {
      const tone = unit.block.status === "cancelled" ? colors.amber : colors.red
      append(italic(fg(tone)(suffix)))
    }
  }
  const renderShellSingleBody = (unit: ToolUnit, selected: boolean, expanded: boolean) => {
    const output = isToolOutputDisplayed(unit.block) ? toolResultText(unit.block.result) : undefined
    const inlineOutput = unit.block.presentation.outputDisplay === "inline"
    append(selected ? bold(statusIcon(unit.block.status)) : statusIcon(unit.block.status))
    append(fg(colors.text)(" "))
    append(bold(fg(colors.gold)("$")))
    append(fg(colors.text)(" "))
    renderShellCommand(unit, "    ", 4, selected)
    renderShellMetadata(unit, "  ")
    if ((expanded || inlineOutput) && output !== undefined && output.length > 0) {
      append(fg(colors.text)("\n"))
      append(dim(fg(colors.text)(wrapBodyText(output, transcriptWrapWidth(model.width), "  "))))
    }
  }
  const renderShellGroupChild = (unit: ToolUnit) => {
    const childId = `tool-child:${unit.block.id}`
    const output = isToolOutputDisplayed(unit.block) ? toolResultText(unit.block.result) : undefined
    const expandable = output !== undefined && output.length > 0
    const childExpanded = rowExpanded(childId)
    append(fg(colors.text)("\n  "))
    const rowStart = context.mark()
    const start = context.line()
    append(statusIcon(unit.block.status))
    append(fg(colors.text)(" "))
    append(bold(fg(colors.gold)("$")))
    append(fg(colors.text)(" "))
    renderShellCommand(unit, "      ", 6)
    if (expandable) context.disclose(rowStart, childExpanded)
    renderShellMetadata(unit, "      ")
    const headerEnd = context.line()
    if (expandable && childExpanded) {
      append(fg(colors.text)("\n"))
      append(dim(fg(colors.text)(wrapBodyText(output, transcriptWrapWidth(model.width), "      "))))
    }
    context.nestedRanges.push({ start, end: context.line(), headerEnd, unit: childId, expandable })
  }
  const renderShellBody = (units: ReadonlyArray<ToolUnit>, selected: boolean, expanded: boolean) => {
    if (units.length === 1) {
      renderShellSingleBody(units[0]!, selected, expanded)
      return
    }
    const { status, failedCount, cancelledCount } = shellGroupState(units)
    const running = status === "running"
    const summary = `${running ? "Running" : "Ran"} ${plural(units.length, "command")}${failedCount > 0 ? `, ${failedCount} failed` : ""}${cancelledCount > 0 ? `, ${cancelledCount} cancelled` : ""}`
    if (selected) highlight(`${rowStatusIcon(status, spinnerFrame)} ${summary}`)
    else {
      append(statusIcon(status))
      for (const chunk of renderToolSummary(
        { primary: running ? "Running" : "Ran", secondary: ` ${plural(units.length, "command")}` },
        { leading: " " },
      )[0]!)
        append(chunk)
      if (failedCount > 0) append(fg(colors.muted)(`, ${failedCount} failed`))
      if (cancelledCount > 0) append(fg(colors.muted)(`, ${cancelledCount} cancelled`))
    }
    if (expanded) for (const unit of units) renderShellGroupChild(unit)
  }
  return { renderExploreBody, renderEditBody, renderShellSingleBody, renderShellBody }
}
