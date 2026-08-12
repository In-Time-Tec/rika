import stringWidth from "string-width"
import { StyledText, dim, fg, bold, type TextChunk } from "@opentui/core"
import type { Model } from "../../state/model/terminal-state"
import { boundedThreadSidebarWidth, contentColumnWidth, isNarrow } from "../../state/model/terminal-layout-state"
import { colors } from "../../presentation/terminal/terminal-theme"
import { toOpenColor } from "../rendering/terminal-text-adapter"
import { shortcutsContent } from "./opentui-composer-region"
import { formatActivity } from "../../state/model/terminal-activity-state"
import { truncateToWidth } from "../../presentation/terminal/terminal-format"
import { loaderFrame, spinnerFrames } from "../rendering/opentui-spinner"
import { renderSidebar } from "../rendering/opentui-render-block"
import { panelLoading, compactWorkspace } from "./opentui-surface-content"
import { queueContentWidth, wrappedRowCount } from "../../state/model/terminal-layout-composer"
import { displayInput } from "../../state/model/terminal-composer-state"
import { readyOr } from "../../state/model/terminal-loadable-state"
import type { QueueItem } from "../../state/model/terminal-queue-item"
import {
  fittingQueueHint,
  queueEditingHint,
  queueNavigationHint,
  queueHintWidth,
  queueItemLabel,
  displayCursorOffset,
} from "./opentui-queue-presentation"
import { SurfaceTranscriptMount } from "./opentui-surface-transcript-mount"

export abstract class SurfaceLayout extends SurfaceTranscriptMount {
  protected renderLayout(
    model: Model,
    previousModel: Model | undefined,
    sidebarWidth: number,
    contentLeft: number,
    contentWidth: number,
    renderedInputHeight: number,
    sidebarVisible: boolean,
    threadSidebarVisible: boolean,
  ): void {
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
      queueChunks.push(
        item.id === model.queueSelection
          ? bold(fg(toOpenColor(colors.text))(label))
          : fg(toOpenColor(colors.subtle))(label),
      )
      renderedRows += labelRows
      if (index < end - 1) queueChunks.push(fg(toOpenColor(colors.text))("\n"))
    }
    const queueChanged =
      previousModel === undefined ||
      previousModel.queue !== model.queue ||
      previousModel.queueSelection !== model.queueSelection ||
      previousModel.editingTurnId !== model.editingTurnId ||
      previousModel.mode !== model.mode ||
      previousModel.width !== model.width ||
      previousModel.height !== model.height ||
      previousModel.input !== model.input ||
      previousModel.pastedText !== model.pastedText ||
      previousModel.composerHeight !== model.composerHeight ||
      previousModel.shortcutsOpen !== model.shortcutsOpen ||
      previousModel.sidebarWidth !== model.sidebarWidth
    if (queueChanged) this.queueText.content = new StyledText(queueChunks)
    this.queueHint.top = hintTop
    const hintChunks: Array<TextChunk> = []
    for (const [index, segment] of hintSegments.entries()) {
      hintChunks.push(dim(fg(toOpenColor(colors.text))(index === 0 ? " " : " ── ")))
      hintChunks.push(fg(colors[model.mode])(segment.accent))
      if (segment.suffix.length > 0) hintChunks.push(dim(fg(toOpenColor(colors.text))(segment.suffix)))
    }
    if (hintSegments.length > 0) hintChunks.push(dim(fg(toOpenColor(colors.text))(" ")))
    if (queueChanged) this.queueHint.content = new StyledText(hintChunks)
    this.queueHint.visible = hintSegments.length > 0
    this.queueLeftJoint.visible = queue.length > 0
    this.queueRightJoint.visible = queue.length > 0
    this.inputBox.borderColor = toOpenColor(colors.text)
    this.inputBox.title = ""
    this.modeLabel.right = sidebarWidth + 2
    this.renderModeLabel(model)
    const workspaceTitle = isNarrow(model)
      ? ""
      : ` ${compactWorkspace(model.workspace)}${model.branch === undefined ? "" : ` (${model.branch})`} `
    const panelLoadingLabel = panelLoading(model)
    const activityLabel = formatActivity(
      model.activity,
      model.activity?._tag === "Retrying"
        ? Math.max(0, Math.ceil((model.activity.nextAt - this.currentTimeMillis()) / 1000))
        : model.retryCountdown,
    )
    const statusChanged =
      previousModel === undefined ||
      previousModel.activity !== model.activity ||
      previousModel.connectionStatus !== model.connectionStatus ||
      previousModel.retryCountdown !== model.retryCountdown ||
      previousModel.busy !== model.busy ||
      panelLoading(previousModel) !== panelLoadingLabel
    if (statusChanged) {
      if (model.connectionStatus !== undefined || activityLabel !== undefined || panelLoadingLabel !== undefined) {
        const statusName = model.connectionStatus ?? activityLabel ?? panelLoadingLabel!
        this.inputBox.bottomTitle = ""
        this.statusLabel.content = new StyledText([
          fg(toOpenColor(colors.text))(" "),
          fg(toOpenColor(colors.blue))(loaderFrame(statusName, this.loaderController.phase)),
          dim(fg(toOpenColor(colors.text))(` ${statusName} `)),
        ])
      } else {
        this.inputBox.bottomTitle = ""
        this.statusLabel.content = ""
      }
    }
    const goalChanged =
      previousModel === undefined ||
      previousModel.goal !== model.goal ||
      contentColumnWidth(previousModel) !== contentColumnWidth(model)
    if (goalChanged) this.renderGoalLabel(model)
    this.workspaceLabel.right = sidebarWidth + 2
    this.quitConfirmationBox.bottom = renderedInputHeight + 1
    this.quitConfirmationBox.width = Math.max(1, Math.min(24, model.width - 4))
    const workspaceChanged =
      previousModel === undefined ||
      previousModel.workspace !== model.workspace ||
      previousModel.branch !== model.branch ||
      previousModel.width !== model.width
    if (workspaceChanged)
      this.workspaceLabel.content = new StyledText([dim(fg(toOpenColor(colors.text))(workspaceTitle))])
    this.inputBox.height = renderedInputHeight
    const queueHeight = queue.length > 0 ? this.queueBox.height - 1 : 0
    this.modeLabel.top = model.height - renderedInputHeight
    this.queueLeftJoint.top = model.height - renderedInputHeight
    this.queueRightJoint.top = model.height - renderedInputHeight
    this.transcriptPane.setViewportRows(Math.max(1, model.height - renderedInputHeight - queueHeight))
    this.input.visible = model.shortcutsOpen
    const shortcutsChanged =
      previousModel === undefined ||
      previousModel.shortcutsOpen !== model.shortcutsOpen ||
      previousModel.shortcutsTrigger !== model.shortcutsTrigger ||
      previousModel.input !== model.input ||
      previousModel.width !== model.width
    if (shortcutsChanged)
      this.input.content = model.shortcutsOpen ? shortcutsContent(model, Math.max(1, contentWidth - 4)) : ""
    this.composerEditor.visible = !model.shortcutsOpen
    this.composerEditor.height = Math.max(1, renderedInputHeight - 2)
    this.composerEditor.sync(displayInput(model), displayCursorOffset(model))
    this.sidebar.visible = threadSidebarVisible
    this.sidebar.width = boundedThreadSidebarWidth(model.width)
    const sidebarChanged =
      previousModel === undefined ||
      previousModel.threadSidebar !== model.threadSidebar ||
      previousModel.threads !== model.threads ||
      previousModel.mode !== model.mode ||
      previousModel.width !== model.width ||
      previousModel.height !== model.height
    if (sidebarChanged)
      this.sidebar.content = threadSidebarVisible
        ? renderSidebar(model, spinnerFrames[this.loaderController.phase % spinnerFrames.length]!)
        : ""
    this.changedFilesBox.visible = sidebarVisible
    if (this.changedFilesBox.visible) {
      this.changedFilesBox.width = Math.max(1, sidebarWidth - 2)
      this.changedFilesBox.title = model.changedFilesOpen
        ? ` Changed files (${readyOr(model.changedFiles, []).length}) `
        : ` Files (${readyOr(model.filePicker.items, []).length}) `
      this.changedFilesBox.titleAlignment = "left"
      this.changedFilesBox.titleColor = toOpenColor(colors[model.mode])
      this.changedFilesText.fg = toOpenColor(colors.text)
      this.refreshSidebarRows(model)
      if (
        previousModel === undefined ||
        previousModel.width !== model.width ||
        previousModel.height !== model.height ||
        previousModel.sidebarWidth !== model.sidebarWidth ||
        previousModel.changedFilesOpen !== model.changedFilesOpen ||
        previousModel.changedFiles !== model.changedFiles ||
        previousModel.workspaceFilesOpen !== model.workspaceFilesOpen ||
        previousModel.filePicker.items !== model.filePicker.items ||
        previousModel.mode !== model.mode
      )
        this.refreshSidebarAfterLayout()
    } else {
      this.changedFilesHoveredRow = undefined
    }
  }
}
