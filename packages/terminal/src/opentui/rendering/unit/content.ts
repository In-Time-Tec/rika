import { Function, Option, Schema } from "effect"
import { bold, dim, fg, italic, strikethrough, StyledText, type TextChunk } from "@opentui/core"
import { Block } from "@rika/transcript/transcript-presentation-model"
import stringWidth from "string-width"
import type { Model } from "../../../state/model"
import { colors } from "../../../presentation/terminal/theme"
import { truncateToWidth } from "../../../presentation/terminal/format"
import {
  renderMarkdownLines,
  renderMarkdownStyled,
  highlightShellCommand,
  wrapStyledLine,
  toOpenChunk,
} from "../text-adapter"
import { renderToolSummary } from "../diff-text-adapter"
import type { TerminalTextChunk } from "../../../presentation/markdown/styled-text"
import { renderCellBody, renderDiffBody, renderPlainBody, toolOutputDisplayed } from "./bodies"
import { toolDetail, toolDetails } from "../../../presentation/transcript/tool/detail"
import { isExpandableUnit, orderedTranscriptItems, transcriptUnitId } from "../../../presentation/transcript/row"
import type {
  AgentOutcome,
  AgentResponseState,
  CellTranscriptUnit,
  NestedTranscriptUnit,
  SubagentTranscriptUnit,
  ToolTranscriptUnit,
  TranscriptUnit,
} from "../../../presentation/transcript/tool/types"
import {
  wrapTextToWidth,
  wrapBodyText,
  iconChar,
  markerText,
  cancelledAgentLabel,
  failedAgentLabel,
  subagentPhrase,
} from "../window"
import { toolUnitsFor, shellCommandText, shellExitCode, type ToolUnit } from "../tool/detail"
import { transcriptWrapWidth, type TranscriptUnitBuild, type UnitLineRange } from "../transcript/window"
import { createToolBodyRenderer } from "../tool/bodies"

const agentResponseOutcome = (state: AgentResponseState): AgentOutcome =>
  state._tag === "Streaming" ? { kind: "answer", entry: state.answer } : state.outcome

const transcriptUnitBuilderImpl = (model: Model, spinnerFrame: string) => {
  const blockAt = (index: number) => Option.getOrUndefined(Schema.decodeUnknownOption(Block)(model.blocks[index]))
  let chunks: Array<TextChunk> = []
  let line = 0
  const append = (chunk: TextChunk | TerminalTextChunk) => {
    chunks.push(toOpenChunk(chunk))
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
  const statusIcon = (failed: boolean, running: boolean, cancelled = false): TextChunk => {
    if (running) return fg(colors.blue)(spinnerFrame)
    if (cancelled) return fg(colors.amber)("⊘")
    return failed ? fg(colors.red)("✕") : fg(colors.green)("✓")
  }
  const marker = (expanded: boolean): TextChunk => fg(colors.subtle)(expanded ? " ▾" : " ▸")
  const rowExpanded = (id: string): boolean => model.expandedRowKeys.includes(id)
  const highlight = (text: string) => append(bold(fg(colors.blue)(text)))
  let nestedRanges: Array<UnitLineRange> = []
  const renderEntryBody = (index: number) => {
    const entry = model.entries[index]!
    if (entry.role === "assistant") {
      appendAll(renderMarkdownStyled(entry.text.trimEnd(), transcriptWrapWidth(model.width)))
      return
    }
    if (entry.role === "notice") {
      if (entry.text === "cancelled") append(fg(colors.amber)("⊘"))
      else append(fg(colors.amber)(`! ${entry.text}`))
      return
    }
    const wrapWidth = Math.max(1, transcriptWrapWidth(model.width) - 2)
    const wrapped = wrapTextToWidth(entry.text, wrapWidth)
    wrapped.forEach((current, lineIndex) => {
      if (lineIndex > 0) append(fg(colors.text)("\n"))
      append(fg(colors.green)("┃ "))
      append(italic(fg(colors.green)(current)))
    })
  }
  const renderAgentPrompt = (text: string, prefix: string) => {
    const rows = renderMarkdownLines(
      text.trimEnd(),
      Math.max(1, transcriptWrapWidth(model.width) - stringWidth(prefix)),
    )
    for (const row of rows) {
      append(fg(colors.text)("\n"))
      append(dim(fg(colors.subtle)(prefix)))
      for (const chunk of row) append(dim(chunk))
    }
  }

  const renderAgentResponse = (index: number, prefix: string, gap = false): UnitLineRange | undefined => {
    const entry = model.entries[index]
    if (entry?.role !== "assistant" || entry.text.trim().length === 0) return
    const item = orderedTranscriptItems(model).find(
      (candidate) => candidate._tag === "Entry" && candidate.index === index,
    )
    const rows = renderMarkdownLines(
      entry.text.trimEnd(),
      Math.max(1, transcriptWrapWidth(model.width) - stringWidth(prefix)),
    )
    const connector = prefix.lastIndexOf("│")
    const curl = gap && connector >= 0 ? `${prefix.slice(0, connector)}╰${prefix.slice(connector + 1)}` : prefix
    const start = line + 1
    if (gap) {
      for (let spacer = 0; spacer < 2; spacer += 1) {
        append(fg(colors.text)("\n"))
        append(dim(fg(colors.subtle)(prefix.trimEnd())))
      }
    }
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
  const renderAgentError = (
    terminal: Extract<AgentOutcome, { kind: "error" }>,
    ownerId: string,
    prefix: string,
    gap = false,
  ): UnitLineRange | undefined => {
    const text = terminal.text.trim()
    if (text.length === 0) return
    const rows = renderMarkdownLines(text, Math.max(1, transcriptWrapWidth(model.width) - stringWidth(prefix)))
    const connector = prefix.lastIndexOf("│")
    const curl = gap && connector >= 0 ? `${prefix.slice(0, connector)}╰${prefix.slice(connector + 1)}` : prefix
    const start = line + 1
    if (gap) {
      for (let spacer = 0; spacer < 2; spacer += 1) {
        append(fg(colors.text)("\n"))
        append(dim(fg(colors.subtle)(prefix.trimEnd())))
      }
    }
    rows.forEach((row, rowIndex) => {
      append(fg(colors.text)("\n"))
      append(dim(fg(colors.subtle)(rowIndex === rows.length - 1 ? curl : prefix)))
      for (const chunk of row) {
        if (terminal.tone === "failed") append(fg(colors.red)(chunk))
        else if (terminal.tone === "cancelled") append(fg(colors.amber)(chunk))
        else append(dim(chunk))
      }
    })
    return { start, end: line, unit: `agent-terminal:${ownerId}`, expandable: false }
  }
  const toolBodies = createToolBodyRenderer({
    model,
    spinnerFrame,
    append,
    appendAll,
    line: () => line,
    nestedRanges,
    rowExpanded,
    highlight,
    statusIcon,
    marker,
  })

  const renderOtherToolBody = (
    unit: ToolUnit,
    selected: boolean,
    expanded: boolean,
    hasChildren = false,
    hasTerminal = false,
  ) => {
    const failed = unit.block.status === "failed"
    const running = unit.block.status === "running"
    const cancelled = unit.block.status === "cancelled"
    let label = unit.block.presentation.completeLabel
    if (running) label = unit.block.presentation.activeLabel
    else if (cancelled && unit.block.presentation.family === "agent") {
      label = cancelledAgentLabel(unit.block.presentation.activeLabel)
    } else if (failed && unit.block.presentation.family === "agent") {
      label = failedAgentLabel(unit.block.presentation.activeLabel)
    }
    const detail = unit.block.detail.length === 0 ? "" : ` ${unit.block.detail}`
    const agent = unit.block.presentation.family === "agent"
    const shellFailure =
      failed && unit.block.presentation.family === "shell" ? ` (exit code: ${shellExitCode(unit.block) ?? 1})` : ""
    const output = agent || !toolOutputDisplayed(unit.block) ? undefined : unit.block.output
    const expandable =
      hasChildren ||
      hasTerminal ||
      (agent ? running || unit.block.detail.length > 0 : output !== undefined && output.length > 0)
    if (selected)
      highlight(
        `${iconChar(failed, running, spinnerFrame, cancelled)} ${label}${agent ? "" : detail}${shellFailure}${expandable ? markerText(expanded) : ""}`,
      )
    else {
      append(statusIcon(failed, running, cancelled))
      const baseSummary = toolDetail(unit.index, {
        ...unit.block,
        presentation: { ...unit.block.presentation, activeLabel: label, completeLabel: label },
      }).summary
      for (const chunk of renderToolSummary(baseSummary, { leading: " " })[0]!) append(chunk)
      if (shellFailure.length > 0) append(fg(colors.red)(shellFailure))
      if (expandable) append(marker(expanded))
    }
    if (expanded && agent && unit.block.detail.length > 0) {
      renderAgentPrompt(unit.block.detail, "  ")
    } else if (expanded && !agent && output !== undefined) {
      append(fg(colors.text)("\n"))
      if (unit.block.presentation.action === "read-web-page") {
        const rows = renderMarkdownLines(output.trimEnd(), Math.max(1, transcriptWrapWidth(model.width) - 2))
        for (const [rowIndex, row] of rows.entries()) {
          append(dim(fg(colors.text)("  ")))
          for (const chunk of row) append(chunk)
          if (rowIndex < rows.length - 1) append(fg(colors.text)("\n"))
        }
      } else append(dim(fg(colors.text)(wrapBodyText(output, transcriptWrapWidth(model.width), "  "))))
    }
  }
  const renderNestedCell = (unit: CellTranscriptUnit, prefix: string, last: boolean) => {
    const block = blockAt(unit.block)
    if (block?._tag !== "Cell") return
    const expanded = rowExpanded(transcriptUnitId(model, unit))
    const rowWidth = transcriptWrapWidth(model.width)
    const visiblePrefix = truncateToWidth(prefix, Math.max(0, rowWidth - 8))
    const continuationPrefix = `${visiblePrefix}${last ? " " : "│"} `
    append(fg(colors.text)("\n"))
    append(dim(fg(colors.subtle)(`${visiblePrefix}${last ? "└" : "├"} `)))
    const start = line
    const appendIndented = (chunk: TextChunk | TerminalTextChunk) =>
      append(
        chunk.text.includes("\n") ? { ...chunk, text: chunk.text.replaceAll("\n", `\n${continuationPrefix}`) } : chunk,
      )
    renderCellBody(block, false, expanded, rowWidth - stringWidth(continuationPrefix), spinnerFrame, appendIndented)
    nestedRanges.push({
      start,
      end: line,
      headerEnd: start,
      unit: transcriptUnitId(model, unit),
      expandable: true,
      animated: block.status === "running",
    })
  }
  const renderNested = (unit: NestedTranscriptUnit, prefix: string, last: boolean) => {
    if (unit.kind === "cell") renderNestedCell(unit, prefix, last)
    else if (unit.kind === "subagent") renderNestedSubagent(unit, prefix, last)
    else renderNestedTool(unit, prefix, last)
  }
  const renderNestedTool = (unit: ToolTranscriptUnit, prefix: string, last: boolean) => {
    const index = unit.blocks[0]!
    const block = blockAt(index)
    if (block?._tag !== "ToolCall") return
    const id = transcriptUnitId(model, unit)
    const expanded = rowExpanded(id)
    const running = block.status === "running"
    const failed = block.status === "failed"
    const cancelled = block.status === "cancelled"
    const detail = toolDetail(index, block)
    const children = unit.children ?? []
    const agent = block.presentation.family === "agent"
    const output = agent || !toolOutputDisplayed(block) ? undefined : block.output
    const expandable =
      children.length > 0 ||
      unit.agentResponse !== undefined ||
      (agent && (running || block.detail.length > 0)) ||
      (output !== undefined && output.length > 0)
    const rowWidth = transcriptWrapWidth(model.width)
    const visiblePrefix = truncateToWidth(prefix, Math.max(0, rowWidth - 8))
    const branchPrefix = `${visiblePrefix}${last ? "└" : "├"} `
    const continuationPrefix = `${visiblePrefix}${last ? " " : "│"}   `
    append(fg(colors.text)("\n"))
    append(dim(fg(colors.subtle)(branchPrefix)))
    const start = line
    if (cancelled && block.presentation.family === "shell") {
      const command = detail.label.startsWith("$ ") ? detail.label.slice(2) : detail.label
      append(bold(fg(colors.amber)("$ ")))
      const suffix = " (cancelled)"
      const shellContinuationPrefix = `${visiblePrefix}${last ? " " : "│"}     `
      const commandWidth = Math.max(
        1,
        rowWidth - stringWidth(branchPrefix) - 2 - stringWidth(suffix) - (expandable ? 2 : 0),
      )
      for (const [rowIndex, row] of wrapTextToWidth(command, commandWidth).entries()) {
        if (rowIndex > 0) {
          append(fg(colors.text)("\n"))
          append(dim(fg(colors.subtle)(shellContinuationPrefix)))
        }
        append(strikethrough(fg(colors.text)(row)))
      }
      append(italic(fg(colors.amber)(" (cancelled)")))
    } else {
      append(statusIcon(failed, running, cancelled))
      if (block.presentation.family === "shell") {
        const failure = failed ? ` (exit code: ${shellExitCode(block) ?? 1})` : ""
        const shellContinuationPrefix = `${visiblePrefix}${last ? " " : "│"}     `
        const commandWidth = Math.max(
          1,
          rowWidth - stringWidth(branchPrefix) - 4 - stringWidth(failure) - (expandable ? 2 : 0),
        )
        append(fg(colors.text)(" "))
        append(dim(fg(colors.text)("$ ")))
        const command = shellCommandText(block)
        const rows = command
          .split("\n")
          .flatMap((current) => wrapStyledLine(highlightShellCommand(current)[0] ?? [], commandWidth))
        for (const [rowIndex, row] of rows.entries()) {
          if (rowIndex > 0) {
            append(fg(colors.text)("\n"))
            append(dim(fg(colors.subtle)(shellContinuationPrefix)))
          }
          for (const chunk of row) append(chunk)
        }
        if (failure.length > 0) append(fg(colors.red)(failure))
      } else
        for (const [labelIndex, labelLine] of renderToolSummary(detail.summary, {
          width: rowWidth - stringWidth(continuationPrefix) - (expandable ? 2 : 0),
        }).entries()) {
          if (labelIndex > 0) {
            append(fg(colors.text)("\n"))
            append(dim(fg(colors.subtle)(continuationPrefix)))
          } else append(fg(colors.text)(" "))
          for (const chunk of labelLine) append(chunk)
        }
    }
    if (expandable) append(marker(expanded))
    const headerEnd = line
    const rangeIndex = nestedRanges.length
    const nestedRangeBase: UnitLineRange = {
      start,
      end: start,
      headerEnd,
      unit: id,
      expandable,
      animated: running,
    }
    const nestedRange: UnitLineRange =
      detail.target === undefined ? nestedRangeBase : { ...nestedRangeBase, targets: [detail.target] }
    nestedRanges.push(nestedRange)
    const bodyPrefix = `${visiblePrefix}${last ? "  " : "│ "}`
    const bodyIndent = `${bodyPrefix}  `
    if (expanded && agent && block.detail.length > 0) {
      renderAgentPrompt(block.detail, bodyIndent)
    } else if (expanded && output !== undefined && output.length > 0) {
      const outputIndent = block.presentation.family === "shell" ? `${bodyIndent}  ` : bodyIndent
      const outputWidth = Math.max(1, rowWidth - stringWidth(outputIndent))
      const renderedOutput = wrapTextToWidth(output, outputWidth).join(`\n${outputIndent}`)
      append(fg(colors.text)("\n"))
      append(dim(fg(colors.subtle)(outputIndent)))
      append(dim(fg(colors.text)(renderedOutput)))
    }
    if (expanded)
      for (const [childIndex, child] of children.entries())
        renderNested(child, bodyIndent, childIndex === children.length - 1 && unit.agentResponse === undefined)
    if (expanded && unit.agentResponse !== undefined) {
      const timeline = children.length > 0
      const terminalPrefix = timeline ? `${bodyIndent}│   ` : bodyIndent
      const response = agentResponseOutcome(unit.agentResponse)
      const range =
        response.kind === "answer"
          ? renderAgentResponse(response.entry, terminalPrefix, timeline)
          : renderAgentError(response, block.id, terminalPrefix, timeline)
      if (range !== undefined) nestedRanges.push(range)
    }
    nestedRanges[rangeIndex] = {
      ...nestedRanges[rangeIndex]!,
      end: children.length === 0 ? line : (nestedRanges[rangeIndex + 1]?.start ?? start + 1) - 1,
    }
  }
  const renderSubagentHeader = (unit: SubagentTranscriptUnit, expanded: boolean) => {
    const block = blockAt(unit.block)
    if (block?._tag !== "SubagentCard") return
    const running = block.status === "running" || block.status === "waiting" || block.status === "cancelling"
    const failed = block.status === "failed"
    const cancelled = block.status === "cancelled"
    const label = subagentPhrase(block.name, block.status)
    append(block.status === "queued" ? fg(colors.subtle)("◷") : statusIcon(failed, running, cancelled))
    append(fg(colors.text)(` ${label}`))
    append(marker(expanded))
  }
  const renderSubagentContents = (unit: SubagentTranscriptUnit, bodyIndent: string) => {
    const block = blockAt(unit.block)
    if (block?._tag !== "SubagentCard") return
    if (block.prompt.length > 0) renderAgentPrompt(block.prompt, bodyIndent)
    if (block.promptTruncated)
      append(dim(fg(colors.amber)(`\n${bodyIndent}Prompt truncated; inspect the source request for full detail.`)))
    for (const [childIndex, child] of unit.children.entries())
      renderNested(child, bodyIndent, childIndex === unit.children.length - 1 && unit.agentResponse === undefined)
    if (unit.agentResponse !== undefined) {
      const timeline = unit.children.length > 0
      const prefix = timeline ? `${bodyIndent}│   ` : bodyIndent
      const outcome = agentResponseOutcome(unit.agentResponse)
      const range =
        outcome.kind === "answer"
          ? renderAgentResponse(outcome.entry, prefix, timeline)
          : renderAgentError(outcome, block.id, prefix, timeline)
      if (range !== undefined) nestedRanges.push(range)
    }
  }
  const renderNestedSubagent = (unit: SubagentTranscriptUnit, prefix: string, last: boolean) => {
    const block = blockAt(unit.block)
    if (block?._tag !== "SubagentCard") return
    const id = transcriptUnitId(model, unit)
    const expanded = rowExpanded(id)
    const running = block.status === "running" || block.status === "waiting" || block.status === "cancelling"
    const visiblePrefix = truncateToWidth(prefix, Math.max(0, transcriptWrapWidth(model.width) - 8))
    append(fg(colors.text)("\n"))
    append(dim(fg(colors.subtle)(`${visiblePrefix}${last ? "└" : "├"} `)))
    const start = line
    renderSubagentHeader(unit, expanded)
    const rangeIndex = nestedRanges.length
    nestedRanges.push({
      start,
      end: start,
      headerEnd: line,
      unit: id,
      expandable: true,
      animated: unit.agentResponse?._tag !== "Streaming" && running,
    })
    if (expanded) renderSubagentContents(unit, `${visiblePrefix}${last ? "  " : "│ "}  `)
    nestedRanges[rangeIndex] = {
      ...nestedRanges[rangeIndex]!,
      end: (nestedRanges[rangeIndex + 1]?.start ?? line + 1) - 1,
    }
  }
  const renderSubagentUnitBody = (unit: SubagentTranscriptUnit, expanded: boolean) => {
    renderSubagentHeader(unit, expanded)
    if (expanded) renderSubagentContents(unit, "  ")
  }
  const renderCellUnitBody = (index: number, selected: boolean, expanded: boolean) => {
    const block = blockAt(index)
    if (block?._tag !== "Cell") return
    renderCellBody(block, selected, expanded, transcriptWrapWidth(model.width), spinnerFrame, append)
  }
  const renderDiffUnitBody = (index: number, selected: boolean, expanded: boolean) => {
    const block = blockAt(index)
    if (block?._tag !== "Diff") return
    renderDiffBody(block, selected, expanded, transcriptWrapWidth(model.width), append, appendAll)
  }
  const renderReasoningBody = (index: number, selected: boolean) => {
    const block = blockAt(index)
    if (block?._tag !== "Reasoning") return
    const text = wrapTextToWidth(block.text, transcriptWrapWidth(model.width)).join("\n")
    append(selected ? bold(fg(colors.blue)(text)) : dim(italic(fg(colors.text)(text))))
  }
  const renderPlainBlock = (index: number, selected: boolean, expanded: boolean) => {
    const block = blockAt(index)
    if (block === undefined) return
    const width = transcriptWrapWidth(model.width)
    if (block._tag === "AuthorizationCard") {
      let icon = "✕"
      if (block.status === "pending") icon = "?"
      else if (block.status === "approved") icon = "✓"
      let color = colors.amber
      if (block.status === "denied" || block.status === "cancelled" || block.status === "expired") color = colors.red
      else if (selected) color = colors.blue
      append(fg(color)(`${icon} Authorization ${block.status}: ${block.operation}${expanded ? " ▾" : " ▸"}`))
      if (selected && block.status === "pending" && model.input.length === 0)
        append(bold(fg(colors.blue)("\n  [a] Approve   [d] Deny")))
      if (expanded) {
        append(dim(fg(colors.text)(`\n  Capability: ${block.capability}`)))
        if (block.input.length > 0) append(dim(fg(colors.text)(`\n${wrapBodyText(block.input, width, "  ")}`)))
        if (block.inputTruncated)
          append(dim(fg(colors.amber)("\n  Input truncated; inspect the source request for full detail.")))
      }
      return
    }
    renderPlainBody(model, block, width, append)
  }
  const isUnitVisible = (unit: TranscriptUnit): boolean =>
    unit.kind !== "reasoning" || rowExpanded(transcriptUnitId(model, unit))
  const renderUnit = (unit: TranscriptUnit): TranscriptUnitBuild => {
    chunks = []
    line = 0
    nestedRanges.length = 0
    const expandable = isExpandableUnit(model, unit)
    const id = transcriptUnitId(model, unit)
    const expanded =
      rowExpanded(id) ||
      (unit.kind === "tool" &&
        unit.group === "edit" &&
        toolUnitsFor(model, unit.blocks).some((toolUnit) => toolUnit.block.status === "running"))
    const selected = expandable && model.detailSelection === id
    const start = line
    const chunkStart = chunks.length
    if (unit.kind === "entry") renderEntryBody(unit.entry)
    else if (unit.kind === "reasoning") renderReasoningBody(unit.block, selected)
    else if (unit.kind === "subagent") renderSubagentUnitBody(unit, expanded)
    else if (unit.kind === "cell") renderCellUnitBody(unit.block, selected, expanded)
    else if (unit.kind === "diff") renderDiffUnitBody(unit.block, selected, expanded)
    else if (unit.kind === "block") renderPlainBlock(unit.block, selected, expanded)
    else if (unit.children !== undefined || unit.agentResponse !== undefined) {
      renderOtherToolBody(
        toolUnitsFor(model, unit.blocks)[0]!,
        selected,
        expanded,
        unit.children !== undefined,
        unit.agentResponse !== undefined,
      )
      if (expanded)
        for (const [childIndex, child] of (unit.children ?? []).entries())
          renderNested(child, "  ", childIndex === (unit.children?.length ?? 0) - 1 && unit.agentResponse === undefined)
      if (expanded && unit.agentResponse !== undefined) {
        const timeline = (unit.children?.length ?? 0) > 0
        const prefix = timeline ? "  │   " : "  "
        const ownerId = toolUnitsFor(model, unit.blocks)[0]?.block.id
        if (ownerId !== undefined) {
          const response = agentResponseOutcome(unit.agentResponse)
          const range =
            response.kind === "answer"
              ? renderAgentResponse(response.entry, prefix, timeline)
              : renderAgentError(response, ownerId, prefix, timeline)
          if (range !== undefined) nestedRanges.push(range)
        }
      }
    } else if (unit.group === "explore")
      toolBodies.renderExploreBody(toolUnitsFor(model, unit.blocks), selected, expanded)
    else if (unit.group === "edit")
      toolBodies.renderEditBody(toolUnitsFor(model, unit.blocks), unit.diffs, selected, expanded)
    else if (unit.group === "shell") toolBodies.renderShellBody(toolUnitsFor(model, unit.blocks), selected, expanded)
    else for (const toolUnit of toolUnitsFor(model, unit.blocks)) renderOtherToolBody(toolUnit, selected, expanded)
    const cancelledAgent =
      unit.kind === "tool" &&
      toolUnitsFor(model, unit.blocks).some(
        (toolUnit) => toolUnit.block.status === "cancelled" && toolUnit.block.presentation.family === "agent",
      )
    if (expanded && cancelledAgent) addExpandedBodyGutter(chunkStart)
    let animated = false
    if (unit.kind === "tool") {
      animated = toolUnitsFor(model, unit.blocks).some((toolUnit) => toolUnit.block.status === "running")
    } else if (unit.kind === "subagent") {
      const block = blockAt(unit.block)
      const status = block?._tag === "SubagentCard" ? block.status : undefined
      const answerDelivered = unit.agentResponse?._tag === "Streaming"
      animated = !answerDelivered && (status === "running" || status === "waiting" || status === "cancelling")
    } else if (unit.kind === "cell") {
      const block = blockAt(unit.block)
      animated = block?._tag === "Cell" && block.status === "running"
    }
    let targets: ReadonlyArray<{ readonly path: string; readonly line?: number; readonly column?: number }> | undefined
    if (unit.kind === "tool") {
      targets = toolDetails(model, unit).flatMap((detail) => (detail.target === undefined ? [] : [detail.target]))
    } else if (unit.kind === "diff") {
      const block = blockAt(unit.block)
      if (block?._tag === "Diff") targets = [{ path: block.path }]
    }
    const rootBase: UnitLineRange = {
      start,
      end: nestedRanges.length === 0 ? line : nestedRanges[0]!.start - 1,
      unit: id,
      expandable,
      animated,
      gapBefore: false,
    }
    const root: UnitLineRange = targets === undefined ? rootBase : { ...rootBase, targets }
    return { chunks, lines: line, root, nested: nestedRanges }
  }
  return { renderUnit, isUnitVisible }
}

export const transcriptUnitBuilder: {
  (
    arg1: Parameters<typeof transcriptUnitBuilderImpl>[1],
  ): (arg0: Parameters<typeof transcriptUnitBuilderImpl>[0]) => ReturnType<typeof transcriptUnitBuilderImpl>
  (
    arg0: Parameters<typeof transcriptUnitBuilderImpl>[0],
    arg1: Parameters<typeof transcriptUnitBuilderImpl>[1],
  ): ReturnType<typeof transcriptUnitBuilderImpl>
} = Function.dual(2, transcriptUnitBuilderImpl)
