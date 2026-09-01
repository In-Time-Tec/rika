import stringWidth from "string-width"
import { StyledText, dim, fg, bold, type TextChunk } from "@opentui/core"
import type { Model } from "../../state/model"
import { boundedThreadSidebarWidth, isNarrow } from "../../state/layout/model"
import { colors, modeColor } from "../../presentation/terminal/theme"
import { toOpenColor } from "../rendering/text-adapter"
import { shortcutsContent } from "./composer/region"
import { truncateToWidth } from "../../presentation/terminal/format"
import { spinnerFrames } from "../rendering/spinner"
import { renderSidebar } from "../rendering/block"
import { panelLoading, compactWorkspace, statusContent } from "./content"
import { queueContentWidth, wrappedRowCount } from "../../state/layout/composer"
import { displayInput } from "../../state/composer/model"
import { readyOr } from "../../state/loadable"
import {
  fittingQueueHint,
  queueNavigationHint,
  queueHintWidth,
  queueItemContent,
  queueItemLabel,
  displayCursorOffset,
} from "./queue/presentation"
import { SurfaceTranscriptMount } from "./transcript/mount"

const modelFieldsChanged = <K extends keyof Model>(
  previous: Model | undefined,
  model: Model,
  fields: ReadonlyArray<K>,
): boolean => previous === undefined || fields.some((field) => previous[field] !== model[field])

interface QueueRange {
  readonly start: number
  readonly end: number
}

interface QueueRows {
  readonly chunks: Array<TextChunk>
  readonly hintTop: number
}

const queueLabels = (
  queue: Model["queue"],
  steeringTurnIds: ReadonlySet<string>,
  hintIndex: number,
  hintWidth: number,
  showHint: boolean,
  width: number,
): ReadonlyArray<string> =>
  queue.map((item, index) => {
    const content = queueItemContent(item)
    const itemLabel = queueItemLabel(item)
    const firstLine = itemLabel.split("\n", 1)[0] ?? ""
    const responsiveLabel = item.provisional !== true && stringWidth(firstLine) > width ? content : itemLabel
    const label = steeringTurnIds.has(item.id) ? `steering: ${content}` : responsiveLabel
    if (index !== hintIndex || !showHint) return label
    const [first = "", ...remaining] = label.split("\n")
    const available = width - hintWidth
    const inline = stringWidth(first) <= available ? first : `${truncateToWidth(first, Math.max(1, available - 1))}…`
    return [inline, ...remaining].join("\n")
  })

const visibleQueueRange = (heights: ReadonlyArray<number>, focusIndex: number, availableRows: number): QueueRange => {
  let start = focusIndex
  let end = focusIndex + 1
  let used = Math.min(availableRows, heights[focusIndex] ?? 0)
  while (end < heights.length && used + heights[end]! <= availableRows) used += heights[end++]!
  while (start > 0 && used + heights[start - 1]! <= availableRows) used += heights[--start]!
  return { start, end }
}

const workspaceTitle = (model: Model): string => {
  if (isNarrow(model)) return ""
  const branch = model.branch === undefined ? "" : ` (${model.branch})`
  return ` ${compactWorkspace(model.workspace)}${branch} `
}

const queueHintSegments = (item: Model["queue"][number] | undefined, canSteer: boolean, width: number) => {
  if (item === undefined || item.provisional === true) return []
  return fittingQueueHint(queueNavigationHint(canSteer), width)
}

export abstract class SurfaceLayout extends SurfaceTranscriptMount {
  private queueRowChunks(
    model: Model,
    queue: Model["queue"],
    steeringLabels: ReadonlyArray<string>,
    labels: ReadonlyArray<string>,
    hintIndex: number,
    showHint: boolean,
    start: number,
    end: number,
    availableRows: number,
    queueTextWidth: number,
  ): QueueRows {
    const chunks: Array<TextChunk> = []
    let hintTop = 0
    let renderedRows = 0
    for (const [index, label] of steeringLabels.entries()) {
      if (renderedRows >= availableRows) break
      chunks.push(fg(toOpenColor(colors.muted))(label))
      renderedRows += 1
      if (index < steeringLabels.length - 1 || queue.length > 0) chunks.push(fg(toOpenColor(colors.text))("\n"))
    }
    hintTop = renderedRows
    for (const [offset, item] of queue.slice(start, end).entries()) {
      const index = start + offset
      const source = labels[index]!
      const label =
        wrappedRowCount(source, queueTextWidth) <= availableRows
          ? source
          : `${truncateToWidth(source.replace(/\n/g, " "), Math.max(1, availableRows * queueTextWidth - 1))}…`
      if (index === hintIndex && showHint) hintTop = renderedRows
      chunks.push(
        item.id === model.queueSelection
          ? bold(fg(toOpenColor(colors.text))(label))
          : fg(toOpenColor(colors.subtle))(label),
      )
      renderedRows += wrappedRowCount(label, queueTextWidth)
      if (index < end - 1) chunks.push(fg(toOpenColor(colors.text))("\n"))
    }
    return { chunks, hintTop }
  }

  private renderQueue(
    model: Model,
    previousModel: Model | undefined,
    contentWidth: number,
    renderedInputHeight: number,
  ): void {
    const queue = model.queue
    const visibleQueue =
      model.editingTurnId === undefined ? queue : queue.filter((item) => item.id !== model.editingTurnId)
    const queuedTurnIds = new Set(queue.map((item) => item.id))
    const localSteeringByTurnId = new Map(
      model.steeringRequests.flatMap((request) =>
        request.origin === "queue" ? [[request.queuedTurnId, request] as const] : [],
      ),
    )
    const localRequestIds = new Set(model.steeringRequests.map((request) => request.requestId))
    const steering = [
      ...model.steeringRequests.filter(
        (request) => request.origin === "composer" || !queuedTurnIds.has(request.queuedTurnId),
      ),
      ...model.pendingSteering.filter((request) => !localRequestIds.has(request.requestId)),
    ]
    const margin = contentWidth <= 4 ? 0 : 1
    this.queueBox.marginLeft = margin
    this.queueBox.marginRight = margin
    this.queueBox.visible = visibleQueue.length > 0 || steering.length > 0
    const queueTextWidth = queueContentWidth(model)
    const queueLength = visibleQueue.length
    const selectedIndex = visibleQueue.findIndex(
      (item) => item.id === model.queueSelection && !localSteeringByTurnId.has(item.id),
    )
    const hintIndex = selectedIndex
    const hintSegments = queueHintSegments(visibleQueue[hintIndex], model.activeTurnId !== undefined, queueTextWidth)
    const hintWidth = queueHintWidth(hintSegments)
    const labels = queueLabels(
      visibleQueue,
      new Set(localSteeringByTurnId.keys()),
      hintIndex,
      hintWidth,
      hintSegments.length > 0,
      queueTextWidth,
    )
    const heights = labels.map((label) => wrappedRowCount(label, queueTextWidth))
    const steeringLabels = steering.map((row) => {
      const label = `steering: ${row.text.split("\n")[0] ?? ""}`
      return stringWidth(label) <= queueTextWidth
        ? label
        : `${truncateToWidth(label, Math.max(1, queueTextWidth - 1))}…`
    })
    const queueRows = heights.reduce((sum, rows) => sum + rows, 0) + steeringLabels.length
    const queueBoxHeight = Math.min(
      Math.max(1, model.height),
      Math.min(Math.max(3, model.height - renderedInputHeight - 2), Math.max(3, queueRows + 2)),
    )
    this.queueBox.minHeight = Math.min(3, queueBoxHeight)
    this.queueBox.height = queueBoxHeight
    const availableRows = Math.max(1, queueBoxHeight - 2)
    const focusIndex = hintIndex < 0 ? queueLength - 1 : hintIndex
    const { start, end } = visibleQueueRange(heights, focusIndex, availableRows)
    const { chunks: queueChunks, hintTop } = this.queueRowChunks(
      model,
      visibleQueue,
      steeringLabels,
      labels,
      hintIndex,
      hintSegments.length > 0,
      start,
      end,
      availableRows,
      queueTextWidth,
    )
    const queueChanged = modelFieldsChanged(previousModel, model, [
      "queue",
      "steeringRequests",
      "pendingSteering",
      "queueSelection",
      "editingTurnId",
      "activeTurnId",
      "mode",
      "width",
      "height",
      "input",
      "pastedText",
      "composerHeight",
      "shortcutsOpen",
      "sidebarWidth",
    ])
    if (queueChanged) this.queueText.content = new StyledText(queueChunks)
    this.queueHint.top = hintTop
    const hintChunks: Array<TextChunk> = []
    for (const [index, segment] of hintSegments.entries()) {
      hintChunks.push(dim(fg(toOpenColor(colors.text))(index === 0 ? " " : " ── ")))
      hintChunks.push(fg(modeColor(model.mode))(segment.accent))
      if (segment.suffix.length > 0) hintChunks.push(dim(fg(toOpenColor(colors.text))(segment.suffix)))
    }
    if (hintSegments.length > 0) hintChunks.push(dim(fg(toOpenColor(colors.text))(" ")))
    if (queueChanged) this.queueHint.content = new StyledText(hintChunks)
    this.queueHint.visible = hintSegments.length > 0
    this.queueLeftJoint.visible = visibleQueue.length > 0 || steering.length > 0
    this.queueRightJoint.visible = visibleQueue.length > 0 || steering.length > 0
  }

  private renderComposerChrome(
    model: Model,
    previousModel: Model | undefined,
    sidebarWidth: number,
    contentWidth: number,
    renderedInputHeight: number,
  ): void {
    this.inputBox.borderColor = toOpenColor(colors.text)
    this.inputBox.title = model.connection?.target === "orb" ? " Orb " : ""
    this.inputBox.titleColor = toOpenColor(modeColor(model.mode))
    this.modeLabel.right = sidebarWidth + 2
    this.renderModeLabel(model)
    const title = workspaceTitle(model)
    const panelLoadingLabel = panelLoading(model)
    const statusChanged =
      modelFieldsChanged(previousModel, model, ["activity", "connection", "retryCountdown", "busy", "editingTurnId"]) ||
      (previousModel !== undefined && panelLoading(previousModel) !== panelLoadingLabel)
    if (statusChanged) {
      this.inputBox.bottomTitle = ""
      this.statusLabel.content = statusContent(model, this.loaderController.phase, this.currentTimeMillis())
    }
    this.workspaceLabel.right = sidebarWidth + 2
    this.ctrlCMenuBox.bottom = renderedInputHeight + 1
    const ctrlCMenuWidth = Math.max(1, Math.min(33, model.width - 4))
    this.ctrlCMenuBox.width = ctrlCMenuWidth
    this.ctrlCMenuTitle.left = model.width - ctrlCMenuWidth - 1
    this.ctrlCMenuTitle.top = Math.max(0, model.height - renderedInputHeight - 7)
    this.ctrlCMenuTitle.visible = this.ctrlCMenuBox.visible && model.width >= 19
    const workspaceChanged = modelFieldsChanged(previousModel, model, ["workspace", "branch", "width"])
    if (workspaceChanged) this.workspaceLabel.content = new StyledText([dim(fg(toOpenColor(colors.text))(title))])
    this.inputBox.height = renderedInputHeight
    const queueHeight = this.queueBox.visible ? this.queueBox.height - 1 : 0
    this.modeLabel.top = model.height - renderedInputHeight
    this.queueLeftJoint.top = model.height - renderedInputHeight
    this.queueRightJoint.top = model.height - renderedInputHeight
    this.transcriptPane.setViewportRows(Math.max(1, model.height - renderedInputHeight - queueHeight))
    this.input.visible = model.shortcutsOpen
    const shortcutsChanged = modelFieldsChanged(previousModel, model, [
      "shortcutsOpen",
      "shortcutsTrigger",
      "input",
      "width",
    ])
    if (shortcutsChanged)
      this.input.content = model.shortcutsOpen ? shortcutsContent(model, Math.max(1, contentWidth - 4)) : ""
    this.composerEditor.visible = !model.shortcutsOpen
    this.composerEditor.height = Math.max(1, renderedInputHeight - 2)
    this.composerEditor.sync(displayInput(model), displayCursorOffset(model))
  }

  private renderSidebars(
    model: Model,
    previousModel: Model | undefined,
    sidebarWidth: number,
    sidebarVisible: boolean,
    threadSidebarVisible: boolean,
  ): void {
    this.sidebar.visible = threadSidebarVisible
    this.sidebar.width = boundedThreadSidebarWidth(model.width)
    const sidebarChanged = modelFieldsChanged(previousModel, model, [
      "threadSidebar",
      "threads",
      "mode",
      "width",
      "height",
    ])
    if (sidebarChanged)
      this.sidebar.content = threadSidebarVisible
        ? renderSidebar(model, spinnerFrames[this.loaderController.phase % spinnerFrames.length])
        : ""
    this.changedFilesBox.visible = sidebarVisible
    if (this.changedFilesBox.visible) {
      this.changedFilesBox.width = Math.max(1, sidebarWidth - 2)
      this.changedFilesBox.title = model.changedFilesOpen
        ? ` Changed files (${readyOr(model.changedFiles, []).length}) `
        : ` Files (${readyOr(model.filePicker.items, []).length}) `
      this.changedFilesBox.titleAlignment = "left"
      this.changedFilesBox.titleColor = toOpenColor(modeColor(model.mode))
      this.changedFilesText.fg = toOpenColor(colors.text)
      this.refreshSidebarRows(model)
      if (
        modelFieldsChanged(previousModel, model, [
          "width",
          "height",
          "sidebarWidth",
          "changedFilesOpen",
          "changedFiles",
          "workspaceFilesOpen",
          "mode",
        ]) ||
        (previousModel !== undefined && previousModel.filePicker.items !== model.filePicker.items)
      )
        this.refreshSidebarAfterLayout()
    } else {
      this.changedFilesHoveredRow = undefined
    }
  }

  protected renderLayout(
    model: Model,
    previousModel: Model | undefined,
    sidebarWidth: number,
    _contentLeft: number,
    contentWidth: number,
    renderedInputHeight: number,
    sidebarVisible: boolean,
    threadSidebarVisible: boolean,
  ): void {
    this.renderQueue(model, previousModel, contentWidth, renderedInputHeight)
    this.renderComposerChrome(model, previousModel, sidebarWidth, contentWidth, renderedInputHeight)
    this.renderSidebars(model, previousModel, sidebarWidth, sidebarVisible, threadSidebarVisible)
  }
}
