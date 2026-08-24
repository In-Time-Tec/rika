import { bold, dim, fg, italic, strikethrough, StyledText, type TextChunk } from "@opentui/core"
import stringWidth from "string-width"
import type { Model } from "../../../state/model"
import { decodeTranscriptBlocks, type TranscriptBlock } from "../../../state/transcript/model"
import { colors } from "../../../presentation/terminal/theme"
import { plural } from "../../../presentation/terminal/format"
import { highlightShellCommand, wrapStyledLine } from "../text-adapter"
import {
  renderDiffStyled,
  renderPartialDiffStyled,
  renderPierreDiff,
  renderToolSummary,
} from "../diff-text-adapter"
import { transcriptWrapWidth } from "../transcript/window"
import { wrapTextToWidth, wrapBodyText, iconChar, markerText } from "../window"
import {
  inputString,
  toolInputValue,
  diffCounts,
  shellCommandText,
  shellExitCode,
  exploreChildLabel,
  type ToolUnit,
} from "./detail"
import { toolDetails } from "../../../presentation/transcript/tool/detail"
import { isToolOutputDisplayed } from "../../../presentation/transcript/agent-response"
import { isExpandableBody, toolBody } from "../../../presentation/transcript/tool/body"
import type { UnitLineRange } from "../transcript/window"

const numberedLine = /^(\d+):\s?(.*)$/
const readWindowPatch = (block: Extract<TranscriptBlock, { _tag: "ToolCall" }>): string | undefined => {
  const body = toolBody(block)
  if (body._tag !== "FileWindow") return undefined
  const lines = body.lines.split("\n")
  const parsed = lines.map((line) => numberedLine.exec(line))
  if (parsed.some((match) => match === null)) return undefined
  const content = parsed.map((match) => ` ${match![2]}`).join("\n")
  return `--- a/${body.path}\n+++ b/${body.path}\n@@ -${body.start},${lines.length} +${body.start},${lines.length} @@\n${content}`
}

export interface ToolBodyContext {
  readonly model: Model
  readonly spinnerFrame: string
  readonly append: (chunk: TextChunk) => void
  readonly appendAll: (styled: StyledText) => void
  readonly line: () => number
  readonly nestedRanges: Array<UnitLineRange>
  readonly rowExpanded: (id: string) => boolean
  readonly highlight: (text: string) => void
  readonly statusIcon: (failed: boolean, running: boolean, cancelled?: boolean) => TextChunk
  readonly marker: (expanded: boolean) => TextChunk
}

export const createToolBodyRenderer = (context: ToolBodyContext) => {
  const { model, spinnerFrame, append, appendAll, rowExpanded, highlight, statusIcon, marker } = context
  const renderExploreBody = (units: ReadonlyArray<ToolUnit>, selected: boolean, expanded: boolean) => {
    const running = units.some((unit) => unit.block.status === "running")
    const complete = units.some((unit) => unit.block.status === "complete")
    const failed = !running && !complete && units.some((unit) => unit.block.status === "failed")
    const cancelled = !running && !complete && !failed && units.some((unit) => unit.block.status === "cancelled")
    const counters = new Map<string, number>()
    for (const unit of units) {
      const counter = unit.block.presentation.counter ?? (unit.kind === "read" ? "file" : "search")
      counters.set(counter, (counters.get(counter) ?? 0) + 1)
    }
    const counts = [...counters].map(([counter, count]) => plural(count, counter)).join(", ")
    if (selected)
      highlight(
        `${iconChar(failed, running, spinnerFrame, cancelled)} ${running ? "Exploring" : "Explored"} ${counts.length > 0 ? counts : "workspace"}${markerText(expanded)}`,
      )
    else {
      append(statusIcon(failed, running, cancelled))
      for (const chunk of renderToolSummary(
        { primary: running ? "Exploring" : "Explored", secondary: ` ${counts.length > 0 ? counts : "workspace"}` },
        { leading: " " },
      )[0]!)
        append(chunk)
      append(marker(expanded))
    }
    if (expanded)
      for (const unit of units) {
        append(fg(colors.text)("\n "))
        const start = context.line()
        append(
          statusIcon(
            unit.block.status === "failed",
            unit.block.status === "running",
            unit.block.status === "cancelled",
          ),
        )
        const detail = toolDetails(model, { kind: "tool", group: "explore", blocks: [unit.index], diffs: [] })[0]!
        let summary = detail.summary
        if (unit.block.presentation.action === "skill") summary = { primary: exploreChildLabel(unit) }
        else if (unit.block.presentation.action === "git-status")
          summary = { primary: "Checked", secondary: ` ${unit.block.detail || "workspace"}` }
        const childId = `tool-child:${unit.block.id}`
        for (const chunk of renderToolSummary(summary, { leading: " " })[0]!) append(chunk)
        const output =
          unit.block.status === "failed" && isToolOutputDisplayed(unit.block)
            ? unit.block.output?.split("\n").find((value) => value.length > 0)
            : undefined
        if (output !== undefined) append(dim(fg(colors.text)(` ${output}`)))
        const childOutput = isToolOutputDisplayed(unit.block) ? unit.block.output : undefined
        const childExpandable = isExpandableBody(toolBody(unit.block))
        if (childExpandable) append(marker(rowExpanded(childId)))
        const headerEnd = context.line()
        if (childExpandable && rowExpanded(childId)) {
          append(fg(colors.text)("\n"))
          const window = readWindowPatch(unit.block)
          const styled =
            window === undefined
              ? undefined
              : renderPierreDiff(window, { width: Math.max(8, transcriptWrapWidth(model.width) - 4), indent: 4 })
          if (styled === undefined)
            append(dim(fg(colors.text)(wrapBodyText(childOutput ?? "", transcriptWrapWidth(model.width), "    "))))
          else appendAll(styled)
        }
        const nestedRange = {
          start,
          end: context.line(),
          headerEnd,
          unit: childId,
          expandable: childExpandable,
          animated: unit.block.status === "running",
        }
        context.nestedRanges.push(
          detail?.target === undefined ? nestedRange : { ...nestedRange, targets: [detail.target] },
        )
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
            : [inputString(toolInputValue(unit.block.input), ["path", "file_path", "file"]) ?? ""],
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
      const diff = decodeTranscriptBlocks(model.blocks)[diffIndex]
      if (diff?._tag !== "Diff") continue
      const [a, r] = diffCounts(diff.patch)
      added += a
      removed += r
    }
    const creates = diffs.length === 0 && allFiles.length > 0 && allFiles.every((file) => file.kind === "add")
    const label = paths.length === 1 ? paths[0] : plural(paths.length, "file")
    let verb = running ? "Editing" : "Edited"
    if (creates) verb = running ? "Creating" : "Created"
    else if (paths.length === 1 && units.length === 1) {
      verb = running ? units[0]!.block.presentation.activeLabel : units[0]!.block.presentation.completeLabel
    }
    const counts = `${added > 0 ? ` +${added}` : ""}${removed > 0 ? ` -${removed}` : ""}`
    if (selected)
      highlight(
        `${iconChar(failed, running, spinnerFrame, cancelled)} ${verb} ${label}${counts}${markerText(expanded)}`,
      )
    else {
      append(statusIcon(failed, running, cancelled))
      for (const chunk of renderToolSummary({ primary: verb, secondary: ` ${label}` }, { leading: " " })[0]!)
        append(chunk)
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
            renderPierreDiff(file.patch, { width: transcriptWrapWidth(model.width) }) ??
              (file.preview
                ? renderPartialDiffStyled(file.patch, { width: transcriptWrapWidth(model.width) })
                : undefined) ??
              renderDiffStyled(file.patch, { width: transcriptWrapWidth(model.width) }),
          )
        }
      } else {
        for (const file of files) {
          append(fg(colors.text)("\n  "))
          const start = context.line()
          const childId = `file:${file.key}`
          const childExpanded = rowExpanded(childId) || running
          const fileRunning = running && file.status === "running"
          append(statusIcon(file.status === "failed", fileRunning, cancelled && file.status === "running"))
          for (const chunk of renderToolSummary(
            { primary: file.kind === "add" ? "Create" : "Edit", secondary: ` ${file.path}` },
            { leading: " " },
          )[0]!)
            append(chunk)
          if (file.additions > 0) append(fg(colors.green)(` +${file.additions}`))
          if (file.deletions > 0) append(fg(colors.red)(` -${file.deletions}`))
          append(marker(childExpanded))
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
      }
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
  }
  const renderShellSingleBody = (unit: ToolUnit, selected: boolean, expanded: boolean) => {
    const command = shellCommandText(unit.block)
    const failed = unit.block.status === "failed"
    const running = unit.block.status === "running"
    const cancelled = unit.block.status === "cancelled"
    const lines = command.split("\n")
    const output = isToolOutputDisplayed(unit.block) ? unit.block.output : undefined
    const inlineOutput = unit.block.presentation.outputDisplay === "inline"
    const expandable = !inlineOutput && output !== undefined && output.length > 0
    const exitCode = shellExitCode(unit.block)
    if (selected) {
      const exit = failed ? ` (exit code: ${exitCode ?? 1})` : ""
      const cancellation = cancelled ? " (cancelled)" : ""
      highlight(
        `${running ? spinnerFrame : "$"} ${lines.join("\n    ")}${exit}${cancellation}${expandable ? markerText(expanded) : ""}`,
      )
    } else {
      const highlighted = cancelled ? undefined : highlightShellCommand(command)
      const commandWidth = Math.max(8, transcriptWrapWidth(model.width) - 4)
      lines.forEach((current, lineIndex) => {
        if (lineIndex === 0) {
          if (running) {
            append(statusIcon(false, true))
            append(fg(colors.text)(" "))
          } else if (cancelled) append(bold(fg(colors.amber)("$ ")))
          else append(dim(fg(colors.text)("$ ")))
          if (cancelled) append(strikethrough(fg(colors.text)(wrapTextToWidth(current, commandWidth).join("\n    "))))
          else
            for (const [rowIndex, row] of wrapStyledLine(highlighted?.[lineIndex] ?? [], commandWidth).entries()) {
              if (rowIndex > 0) append(fg(colors.text)("\n    "))
              for (const chunk of row) append(chunk)
            }
        } else if (cancelled)
          append(strikethrough(fg(colors.text)(`\n    ${wrapTextToWidth(current, commandWidth).join("\n    ")}`)))
        else
          for (const row of wrapStyledLine(highlighted?.[lineIndex] ?? [], commandWidth)) {
            append(fg(colors.text)("\n    "))
            for (const chunk of row) append(chunk)
          }
      })
      if (failed) append(fg(colors.red)(` (exit code: ${exitCode ?? 1})`))
      if (cancelled) append(italic(fg(colors.amber)(" (cancelled)")))
      if (expandable) append(marker(expanded))
    }
    if ((expanded || inlineOutput) && output !== undefined && output.length > 0) {
      append(fg(colors.text)("\n"))
      append(dim(fg(colors.text)(wrapBodyText(output, transcriptWrapWidth(model.width), "  "))))
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
      for (const chunk of renderToolSummary(
        { primary: running ? "Running" : "Ran", secondary: ` ${plural(units.length, "command")}` },
        { leading: " " },
      )[0]!)
        append(chunk)
      if (failedCount > 0) append(fg(colors.muted)(`, ${failedCount} failed`))
      if (cancelledCount > 0) append(fg(colors.muted)(`, ${cancelledCount} cancelled`))
      append(marker(expanded))
    }
    if (expanded)
      for (const unit of units) {
        append(fg(colors.text)("\n   "))
        const start = context.line()
        const childId = `tool-child:${unit.block.id}`
        const childExpanded = rowExpanded(childId)
        const output = isToolOutputDisplayed(unit.block) ? unit.block.output : undefined
        const expandable = output !== undefined && output.length > 0
        const cancelled = unit.block.status === "cancelled"
        const failed = unit.block.status === "failed"
        const failure = failed ? ` (exit code: ${shellExitCode(unit.block) ?? 1})` : ""
        const cancellation = cancelled ? " (cancelled)" : ""
        const commandWidth = Math.max(
          1,
          transcriptWrapWidth(model.width) -
            5 -
            stringWidth(failure) -
            stringWidth(cancellation) -
            (expandable ? 2 : 0),
        )
        if (cancelled) {
          append(bold(fg(colors.amber)("$ ")))
          append(
            strikethrough(fg(colors.text)(wrapTextToWidth(shellCommandText(unit.block), commandWidth).join("\n     "))),
          )
          append(italic(fg(colors.amber)(" (cancelled)")))
        } else {
          append(dim(fg(colors.text)("$ ")))
          const rows = shellCommandText(unit.block)
            .split("\n")
            .flatMap((current) => wrapStyledLine(highlightShellCommand(current)[0] ?? [], commandWidth))
          for (const [rowIndex, row] of rows.entries()) {
            if (rowIndex > 0) append(fg(colors.text)("\n     "))
            for (const chunk of row) append(chunk)
          }
        }
        if (failure.length > 0) append(fg(colors.red)(failure))
        if (expandable) append(marker(childExpanded))
        if (expandable && childExpanded) {
          append(fg(colors.text)("\n"))
          append(dim(fg(colors.text)(wrapBodyText(output!, transcriptWrapWidth(model.width), "     "))))
        }
        context.nestedRanges.push({ start, end: context.line(), unit: childId, expandable })
      }
  }
  return { renderExploreBody, renderEditBody, renderShellSingleBody, renderShellBody }
}
