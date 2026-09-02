import { Function, Option, Schema } from "effect"
import { bold, dim, fg, italic, StyledText, type TextChunk } from "@opentui/core"
import { Block } from "@rika/transcript/transcript-presentation-model"
import stringWidth from "string-width"
import type { Model } from "../../../state/model"
import { colors } from "../../../presentation/terminal/theme"
import { plural, truncateToWidth } from "../../../presentation/terminal/format"
import { renderMarkdownStyled, toOpenChunk } from "../text-adapter"
import { renderReadFile } from "../diff-text-adapter"
import type { TerminalTextChunk } from "../../../presentation/markdown/styled-text"
import { renderDiffBody, renderPlainBody, toolOutputDisplayed } from "./bodies"
import { toolDetail } from "../../../presentation/transcript/tool/detail"
import { isExpandableUnit, isTranscriptUnitExpanded, transcriptUnitId } from "../../../presentation/transcript/row"
import type {
  NestedTranscriptUnit,
  SubagentGroupTranscriptUnit,
  SubagentTranscriptUnit,
  ToolTranscriptUnit,
  TranscriptUnit,
} from "../../../presentation/transcript/tool/types"
import { aggregateRowStatus, rowStatusIcon, wrapBodyText, subagentPhrase, type RowStatus } from "../window"
import { toolUnitsFor, type ToolUnit } from "../tool/detail"
import { transcriptWrapWidth, type TranscriptUnitBuild, type UnitLineRange } from "../transcript/window"
import { createToolBodyRenderer } from "../tool/bodies"
import { readFileBody, toolResultText } from "../../../presentation/transcript/tool/body"
import { fallbackContent } from "./fallback-content"
import { detailContent } from "./detail-content"
import { bodyContent, type TranscriptUnitBuilder } from "./body-content"
import { createAgentContentRenderer } from "./agent-content"
import { disclosure } from "../disclosure"

const displayedToolOutput = (block: ToolUnit["block"]): string | undefined => {
  if (block.presentation.family === "agent" || !toolOutputDisplayed(block)) return undefined
  return toolResultText(block.result)
}

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
  const statusIcon = (status: RowStatus): TextChunk => {
    let color = colors.green
    if (status === "running" || status === "waiting" || status === "cancelling") color = colors.blue
    else if (status === "failed" || status === "rejected") color = colors.red
    else if (status === "cancelled") color = colors.amber
    else if (status === "unknown" || status === "queued") color = colors.subtle
    return fg(color)(rowStatusIcon(status, spinnerFrame))
  }
  const rowExpanded = (id: string): boolean =>
    model.expandedRowKeys.includes(id) && !model.explicitlyCollapsedRowKeys.includes(id)
  const rowExplicitlyCollapsed = (id: string): boolean => model.explicitlyCollapsedRowKeys.includes(id)
  const highlight = (text: string) => append(bold(fg(colors.blue)(text)))
  const mark = () => chunks.length
  const disclose = (from: number, expanded: boolean, selected = false) =>
    disclosure.insertTrailingMarker(chunks, from, disclosure.chunk(expanded, selected))
  const nestedRanges: Array<UnitLineRange> = []
  const agentContent = createAgentContentRenderer({ model, append, appendAll, line: () => line })
  const toolBodies = createToolBodyRenderer({
    model,
    spinnerFrame,
    append,
    appendAll,
    line: () => line,
    mark,
    disclose,
    nestedRanges,
    rowExpanded,
    rowExplicitlyCollapsed,
    highlight,
    statusIcon,
  })

  const renderOtherToolBody = (unit: ToolUnit, selected: boolean, expanded: boolean) =>
    fallbackContent.renderToolBody(
      {
        append,
        highlight,
        renderAgentPrompt: agentContent.renderAgentPrompt,
        statusIcon,
        width: Math.max(1, transcriptWrapWidth(model.width) - 2),
        spinnerFrame,
      },
      unit,
      selected,
      expanded,
    )
  const renderNested = (unit: NestedTranscriptUnit, prefix: string, last: boolean) => {
    if (unit.kind === "subagent") renderNestedSubagent(unit, prefix, last)
    else if (unit.kind === "subagent-group") renderNestedSubagentGroup(unit, prefix, last)
    else renderNestedTool(unit, prefix, last)
  }
  const renderNestedToolContents = (
    unit: ToolTranscriptUnit,
    blockId: string,
    bodyIndent: string,
    expanded: boolean,
  ) => {
    if (!expanded) return
    const children = unit.children ?? []
    for (const [childIndex, child] of children.entries())
      renderNested(child, bodyIndent, childIndex === children.length - 1 && unit.agentResponse === undefined)
    if (unit.agentResponse === undefined) return
    const timeline = children.length > 0
    const terminalPrefix = timeline ? `${bodyIndent}│   ` : bodyIndent
    const response = bodyContent.agentOutcome(unit.agentResponse)
    const range =
      response.kind === "answer"
        ? agentContent.renderAgentResponse(response.entry, terminalPrefix, timeline)
        : agentContent.renderAgentError(response, blockId, terminalPrefix, timeline)
    if (range !== undefined) nestedRanges.push(range)
  }
  const renderNestedToolOutput = (
    block: ToolUnit["block"],
    output: string | undefined,
    bodyIndent: string,
    rowWidth: number,
    expanded: boolean,
  ) => {
    if (!expanded) return
    const file = readFileBody(block)
    if (block.presentation.family === "agent" && block.detail.length > 0)
      agentContent.renderAgentPrompt(block.detail, bodyIndent)
    else if (file !== undefined) {
      append(fg(colors.text)("\n"))
      appendAll(renderReadFile(file.text, { path: file.path, width: rowWidth, indent: bodyIndent }))
    } else if (output !== undefined && output.length > 0)
      detailContent.renderExpandedToolOutput(
        { append },
        output,
        rowWidth,
        block.presentation.family === "shell" ? `${bodyIndent}  ` : bodyIndent,
      )
  }
  const renderNestedTool = (unit: ToolTranscriptUnit, prefix: string, last: boolean) => {
    const index = unit.blocks[0]!
    const block = blockAt(index)
    if (block?._tag !== "ToolCall") return
    const id = transcriptUnitId(model, unit)
    const expanded = rowExpanded(id)
    const running = block.status === "running"
    const detail = toolDetail(index, block)
    const children = unit.children ?? []
    const agent = block.presentation.family === "agent"
    const output = displayedToolOutput(block)
    const expandable = bodyContent.nestedToolExpandable(unit, agent, running, block.detail, output)
    const rowWidth = transcriptWrapWidth(model.width)
    const visiblePrefix = truncateToWidth(prefix, Math.max(0, rowWidth - 12))
    const branchPrefix = `${visiblePrefix}${last ? "└" : "├"} `
    const continuationPrefix = `${visiblePrefix}${last ? " " : "│"}   `
    append(fg(colors.text)("\n"))
    const rowStart = mark()
    append(dim(fg(colors.subtle)(branchPrefix)))
    const start = line
    const shellContinuationPrefix = `${visiblePrefix}${last ? " " : "│"}     `
    detailContent.renderToolHeader(
      { append, statusIcon },
      block,
      detail.label,
      detail.summary,
      rowWidth - 2,
      branchPrefix,
      continuationPrefix,
      shellContinuationPrefix,
      detail.target !== undefined,
    )
    if (expandable) disclose(rowStart, expanded)
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
    renderNestedToolOutput(block, output, bodyIndent, rowWidth, expanded)
    renderNestedToolContents(unit, block.id, bodyIndent, expanded)
    nestedRanges[rangeIndex] = {
      ...nestedRanges[rangeIndex]!,
      end: children.length === 0 ? line : (nestedRanges[rangeIndex + 1]?.start ?? start + 1) - 1,
    }
  }
  const renderSubagentHeader = (unit: SubagentTranscriptUnit, width: number) => {
    const block = blockAt(unit.block)
    if (block?._tag !== "SubagentCard") return
    const label = subagentPhrase(block.name, block.status)
    append(statusIcon(block.status))
    const available = Math.max(0, width - 2)
    const visibleLabel = truncateToWidth(label, available)
    append(fg(colors.text)(` ${visibleLabel}`))
    const latestActivity = block.activity.findLast((activity) => activity.trim().length > 0)
    if (latestActivity === undefined || stringWidth(visibleLabel) >= available) return
    const activity = truncateToWidth(` · ${latestActivity}`, Math.max(0, available - stringWidth(visibleLabel)))
    if (activity.length > 0) append(dim(fg(colors.muted)(activity)))
  }
  const renderSubagentContents = (unit: SubagentTranscriptUnit, bodyIndent: string) => {
    const block = blockAt(unit.block)
    if (block?._tag !== "SubagentCard") return
    if (block.prompt.length > 0) agentContent.renderAgentPrompt(block.prompt, bodyIndent)
    if (block.promptTruncated)
      append(
        dim(
          fg(colors.amber)(`
${bodyIndent}Prompt truncated; inspect the source request for full detail.`),
        ),
      )
    const activities = [...new Set(block.activity.filter((activity) => activity.trim().length > 0))].slice(-4)
    for (const activity of activities) {
      const width = Math.max(1, transcriptWrapWidth(model.width) - stringWidth(bodyIndent) - 2)
      append(
        dim(
          fg(colors.muted)(`
${bodyIndent}· ${truncateToWidth(activity, width)}`),
        ),
      )
    }
    for (const [childIndex, child] of unit.children.entries())
      renderNested(child, bodyIndent, childIndex === unit.children.length - 1 && unit.agentResponse === undefined)
    if (unit.agentResponse !== undefined) {
      const timeline = unit.children.length > 0
      const prefix = timeline ? `${bodyIndent}│   ` : bodyIndent
      const outcome = bodyContent.agentOutcome(unit.agentResponse)
      const range =
        outcome.kind === "answer"
          ? agentContent.renderAgentResponse(outcome.entry, prefix, timeline)
          : agentContent.renderAgentError(outcome, block.id, prefix, timeline)
      if (range !== undefined) nestedRanges.push(range)
    }
  }
  const renderNestedSubagent = (unit: SubagentTranscriptUnit, prefix: string, last: boolean) => {
    const block = blockAt(unit.block)
    if (block?._tag !== "SubagentCard") return
    const id = transcriptUnitId(model, unit)
    const running = block.status === "running" || block.status === "waiting" || block.status === "cancelling"
    const expanded = rowExpanded(id) || (running && !rowExplicitlyCollapsed(id))
    const visiblePrefix = truncateToWidth(prefix, Math.max(0, transcriptWrapWidth(model.width) - 12))
    append(fg(colors.text)("\n"))
    const rowStart = mark()
    append(dim(fg(colors.subtle)(`${visiblePrefix}${last ? "└" : "├"} `)))
    const start = line
    renderSubagentHeader(
      unit,
      Math.max(2, transcriptWrapWidth(model.width) - stringWidth(`${visiblePrefix}${last ? "└" : "├"} `) - 2),
    )
    disclose(rowStart, expanded)
    const rangeIndex = nestedRanges.length
    nestedRanges.push({
      start,
      end: start,
      headerEnd: line,
      unit: id,
      expandable: true,
      animated: running,
    })
    if (expanded) renderSubagentContents(unit, `${visiblePrefix}${last ? "  " : "│ "}  `)
    nestedRanges[rangeIndex] = {
      ...nestedRanges[rangeIndex]!,
      end: (nestedRanges[rangeIndex + 1]?.start ?? line + 1) - 1,
    }
  }
  const renderSubagentUnitBody = (unit: SubagentTranscriptUnit, expanded: boolean) => {
    renderSubagentHeader(unit, Math.max(1, transcriptWrapWidth(model.width) - 2))
    if (expanded) renderSubagentContents(unit, "  ")
  }
  const subagentGroupStatus = (
    block: Extract<NonNullable<ReturnType<typeof blockAt>>, { _tag: "SubagentGroup" }>,
  ): RowStatus => {
    const statuses: Array<RowStatus> = []
    if (block.counts.failed > 0) statuses.push("failed")
    if (block.counts.cancelled > 0) statuses.push("cancelled")
    if (block.counts.cancelling > 0) statuses.push("cancelling")
    if (block.counts.running > 0) statuses.push("running")
    if (block.counts.waiting > 0) statuses.push("waiting")
    if (block.counts.queued > 0) statuses.push("queued")
    if (block.counts.complete > 0) statuses.push("complete")
    return aggregateRowStatus(statuses.length > 0 ? statuses : [block.status])
  }
  const renderSubagentGroupHeader = (unit: SubagentGroupTranscriptUnit, width: number) => {
    const block = blockAt(unit.block)
    if (block?._tag !== "SubagentGroup") return
    const status = subagentGroupStatus(block)
    append(statusIcon(status))
    const counts = block.counts
    const progress = [
      counts.running > 0 ? `${plural(counts.running, "agent")} running` : undefined,
      counts.complete > 0 ? `${plural(counts.complete, "agent")} finished` : undefined,
      counts.queued > 0 ? `${plural(counts.queued, "agent")} queued` : undefined,
      counts.waiting > 0 ? `${plural(counts.waiting, "agent")} waiting` : undefined,
      counts.cancelling > 0 ? `${plural(counts.cancelling, "agent")} stopping` : undefined,
      counts.failed > 0 ? `${plural(counts.failed, "agent")} failed` : undefined,
      counts.cancelled > 0 ? `${plural(counts.cancelled, "agent")} cancelled` : undefined,
    ].filter((part): part is string => part !== undefined)
    const label = progress.length === 0 ? plural(counts.total, "agent") : progress.join(", ")
    append(fg(colors.text)(` ${truncateToWidth(label, Math.max(1, width - 2))}`))
  }
  const renderSubagentGroupContents = (unit: SubagentGroupTranscriptUnit, prefix: string) => {
    for (const [childIndex, child] of unit.children.entries())
      renderNested(child, prefix, childIndex === unit.children.length - 1)
  }
  const renderNestedSubagentGroup = (unit: SubagentGroupTranscriptUnit, prefix: string, last: boolean) => {
    const block = blockAt(unit.block)
    if (block?._tag !== "SubagentGroup") return
    const id = transcriptUnitId(model, unit)
    const running = block.status === "running" || block.status === "cancelling"
    const expanded = rowExpanded(id) || (running && !rowExplicitlyCollapsed(id))
    const visiblePrefix = truncateToWidth(prefix, Math.max(0, transcriptWrapWidth(model.width) - 12))
    append(fg(colors.text)("\n"))
    const rowStart = mark()
    append(dim(fg(colors.subtle)(`${visiblePrefix}${last ? "└" : "├"} `)))
    const start = line
    renderSubagentGroupHeader(unit, Math.max(2, transcriptWrapWidth(model.width) - stringWidth(visiblePrefix) - 4))
    disclose(rowStart, expanded)
    const rangeIndex = nestedRanges.length
    nestedRanges.push({ start, end: start, headerEnd: line, unit: id, expandable: true, animated: running })
    if (expanded) renderSubagentGroupContents(unit, `${visiblePrefix}${last ? "  " : "│ "}  `)
    nestedRanges[rangeIndex] = {
      ...nestedRanges[rangeIndex]!,
      end: (nestedRanges[rangeIndex + 1]?.start ?? line + 1) - 1,
    }
  }
  const renderSubagentGroupUnitBody = (unit: SubagentGroupTranscriptUnit, expanded: boolean) => {
    renderSubagentGroupHeader(unit, Math.max(1, transcriptWrapWidth(model.width) - 2))
    if (expanded) renderSubagentGroupContents(unit, "  ")
  }
  const renderDiffUnitBody = (index: number, selected: boolean, expanded: boolean) => {
    const block = blockAt(index)
    if (block?._tag !== "Diff") return
    renderDiffBody(block, selected, expanded, transcriptWrapWidth(model.width), append, appendAll)
  }
  const renderReasoningBody = (index: number) => {
    const block = blockAt(index)
    if (block?._tag !== "Reasoning") return
    for (const chunk of renderMarkdownStyled(block.text.trimEnd(), transcriptWrapWidth(model.width)).chunks)
      append(dim(italic(chunk)))
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
      append(fg(color)(`${icon} Authorization ${block.status}: ${block.operation}`))
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
  const isUnitVisible = (_unit: TranscriptUnit): boolean => true
  const renderAttachedTool = (
    unit: Extract<TranscriptUnit, { kind: "tool" }>,
    selected: boolean,
    expanded: boolean,
  ) => {
    const tools = toolUnitsFor(model, unit.blocks)
    renderOtherToolBody(tools[0]!, selected, expanded)
    if (!expanded) return
    for (const [childIndex, child] of (unit.children ?? []).entries())
      renderNested(child, "  ", childIndex === (unit.children?.length ?? 0) - 1 && unit.agentResponse === undefined)
    if (unit.agentResponse === undefined) return
    const timeline = (unit.children?.length ?? 0) > 0
    const prefix = timeline ? "  │   " : "  "
    const ownerId = tools[0]?.block.id
    if (ownerId === undefined) return
    const response = bodyContent.agentOutcome(unit.agentResponse)
    const range =
      response.kind === "answer"
        ? agentContent.renderAgentResponse(response.entry, prefix, timeline)
        : agentContent.renderAgentError(response, ownerId, prefix, timeline)
    if (range !== undefined) nestedRanges.push(range)
  }
  const renderUnitBody = (unit: TranscriptUnit, selected: boolean, expanded: boolean) => {
    if (unit.kind === "entry") agentContent.renderEntryBody(unit.entry)
    else if (unit.kind === "reasoning") renderReasoningBody(unit.block)
    else if (unit.kind === "subagent") renderSubagentUnitBody(unit, expanded)
    else if (unit.kind === "subagent-group") renderSubagentGroupUnitBody(unit, expanded)
    else if (unit.kind === "diff") renderDiffUnitBody(unit.block, selected, expanded)
    else if (unit.kind === "block") renderPlainBlock(unit.block, selected, expanded)
    else if (unit.children !== undefined || unit.agentResponse !== undefined)
      renderAttachedTool(unit, selected, expanded)
    else if (unit.group === "explore")
      toolBodies.renderExploreBody(toolUnitsFor(model, unit.blocks), selected, expanded)
    else if (unit.group === "edit")
      toolBodies.renderEditBody(toolUnitsFor(model, unit.blocks), unit.diffs, selected, expanded)
    else if (unit.group === "shell") toolBodies.renderShellBody(toolUnitsFor(model, unit.blocks), selected, expanded)
    else for (const toolUnit of toolUnitsFor(model, unit.blocks)) renderOtherToolBody(toolUnit, selected, expanded)
  }
  const renderUnit = (unit: TranscriptUnit): TranscriptUnitBuild => {
    chunks = []
    line = 0
    nestedRanges.length = 0
    const expandable = isExpandableUnit(model, unit)
    const id = transcriptUnitId(model, unit)
    const expanded = isTranscriptUnitExpanded(model, unit)
    const selected = expandable && model.detailSelection === id
    const start = line
    const chunkStart = chunks.length
    renderUnitBody(unit, selected, expanded)
    if (expandable) disclose(chunkStart, expanded, selected)
    const cancelledAgent =
      unit.kind === "tool" &&
      toolUnitsFor(model, unit.blocks).some(
        (toolUnit) => toolUnit.block.status === "cancelled" && toolUnit.block.presentation.family === "agent",
      )
    if (expanded && cancelledAgent) addExpandedBodyGutter(chunkStart)
    const animated = bodyContent.animated(model, unit)
    const targets = bodyContent.targets(model, unit)
    const rootWithoutHeader: UnitLineRange = {
      start,
      end: nestedRanges.length === 0 ? line : nestedRanges[0]!.start - 1,
      unit: id,
      expandable,
      animated,
      gapBefore: false,
    }
    const root: UnitLineRange = targets === undefined ? rootWithoutHeader : { ...rootWithoutHeader, targets }
    return { chunks, lines: line, root, nested: nestedRanges }
  }
  return { renderUnit, isUnitVisible }
}

export const transcriptUnitBuilder: TranscriptUnitBuilder = Function.dual(2, transcriptUnitBuilderImpl)
