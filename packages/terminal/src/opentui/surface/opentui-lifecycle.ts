import {
  CliRenderEvents,
  TextRenderable,
  StyledText,
  bold,
  dim,
  fg,
  type ColorInput,
  type TextChunk,
} from "@opentui/core"
import stringWidth from "string-width"
import {
  boundedThreadSidebarWidth,
  composerHeight,
  contentColumnWidth,
  displayInput,
  fileSidebarLayoutWidth,
  formatActivity,
  isNarrow,
  queueContentWidth,
  readyOr,
  threadSidebarLayoutWidth,
  wrappedRowCount,
  isThreadBusy,
  type Model,
  type QueueItem,
  type ThreadItem,
  type TranscriptItem,
} from "../../state/model/terminal-state"
import { colors, spacing } from "../../presentation/terminal/terminal-theme"
import { toOpenColor } from "../rendering/terminal-text-adapter"
import {
  includeRowEnd,
  maxMountedTranscriptRows,
  pinnedRowWindow,
  relocateRowEnd,
  rowWindowStart,
} from "../../presentation/transcript/terminal-transcript-presentation"
import { classifyTranscriptContent, isFollowing } from "../../presentation/transcript/transcript-viewport"
import { truncateToWidth } from "../../presentation/terminal/terminal-format"
import { renderSidebar } from "../rendering/opentui-render-block"
import {
  fittingQueueHint,
  queueEditingHint,
  queueNavigationHint,
  queueHintWidth,
  queueItemLabel,
} from "./opentui-surface-construction"
import {
  unitId as transcriptUnitId,
  rows as transcriptUnits,
} from "../../presentation/transcript/terminal-transcript-presentation"
import {
  boundedTranscriptModel,
  transcriptUnitBuilder,
  transcriptUnitRevision,
  maxMountedTranscriptEntries,
  type TranscriptRangeBundle,
  type TranscriptUnitCacheEntry,
} from "../rendering/opentui-renderer"
import { idleSpinnerFrame, loaderFrame, spinnerFrames, spinnerInterval } from "../rendering/opentui-spinner"
import { SurfaceInput } from "./opentui-input"
import { shortcutsContent } from "./opentui-composer-region"
import { panelLoading, compactWorkspace, welcomeContent, welcomeMarkFrames } from "./opentui-surface-content"
import { cutoutBackground, displayCursorOffset } from "./opentui-surface-construction"
import type { TranscriptRenderableDescriptor } from "./opentui-surface-state"

const prependedTranscriptItems = (
  previousItems: ReadonlyArray<unknown>,
  currentItems: ReadonlyArray<unknown>,
): number => {
  const identities = (items: ReadonlyArray<unknown>) =>
    (items as ReadonlyArray<TranscriptItem>).flatMap((item) =>
      item.id === undefined ? [] : [{ id: `${item._tag}:${item.id}` }],
    )
  return classifyTranscriptContent(identities(previousItems), identities(currentItems)).prepended.length
}

export abstract class SurfaceLifecycle extends SurfaceInput {
  showToast(message: string, color: ColorInput = toOpenColor(colors.green)): void {
    const terminalWidth = Math.max(1, this.model?.width ?? this.renderer.width)
    const right = Math.min(2, Math.max(0, terminalWidth - 1))
    const width = Math.max(1, Math.min(stringWidth(message) + 6, terminalWidth - right))
    const visibleMessage = truncateToWidth(message, Math.max(0, width - 6))
    this.toast.content = new StyledText([fg(color)("✓ "), fg(toOpenColor(colors.text))(visibleMessage)])
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
  protected readonly onSelection = (selection: { getSelectedText: () => string }) => {
    const text = selection.getSelectedText().trimEnd()
    if (text.length === 0) return
    this.renderer.copyToClipboardOSC52(text)
    this.showToast("Selection copied to clipboard")
  }

  update(model: Model, preserveTranscriptAnchor = false): void {
    const previousScrollHeight = this.transcriptScroll.scrollHeight
    const previousModel = this.model
    if (previousModel?.currentThreadId !== model.currentThreadId) {
      this.cancelWheelReport()
      this.dispatchTranscriptViewport({ _tag: "ResetCommanded" })
    }
    const scrollFollow = isFollowing(this.transcriptViewport.mode)
    if (model.busy && previousModel?.busy !== true) this.publishWorkingFrame(idleSpinnerFrame)
    else if (!model.busy && previousModel?.busy === true) this.publishWorkingFrame(undefined)
    const transcriptLayoutChanged =
      previousModel !== undefined &&
      (previousModel.items !== model.items ||
        previousModel.entries !== model.entries ||
        previousModel.blocks !== model.blocks ||
        previousModel.expandedRowKeys !== model.expandedRowKeys ||
        contentColumnWidth(previousModel) !== contentColumnWidth(model))
    const transcriptDetachedSameThread =
      previousModel !== undefined &&
      previousModel.currentThreadId === model.currentThreadId &&
      !scrollFollow &&
      (model.entries.length > 0 || model.blocks.length > 0) &&
      transcriptLayoutChanged &&
      this.pendingTranscriptPosition === undefined &&
      this.transcriptViewport.wheel._tag === "Idle"
    const preserveTranscriptPosition = preserveTranscriptAnchor || transcriptDetachedSameThread
    const transcriptAnchor = preserveTranscriptPosition ? this.captureTranscriptAnchor() : undefined
    if (this.transcriptWindowThread !== model.currentThreadId) {
      if (this.transcriptPositionFrame !== undefined)
        this.renderer.off(CliRenderEvents.FRAME, this.transcriptPositionFrame)
      this.transcriptPositionFrame = undefined
      this.pendingTranscriptPosition = undefined
      this.transcriptAnchorScrollBy = 0
      this.transcriptAnchorNearBottom = false
      this.transcriptWindowThread = model.currentThreadId
      this.transcriptWindowEnd = model.items.length
      this.transcriptRowWindow = pinnedRowWindow
      this.transcriptRowTotal = 0
    } else if (preserveTranscriptAnchor)
      this.transcriptWindowEnd = Math.min(
        model.items.length,
        this.transcriptWindowEnd + prependedTranscriptItems(previousModel?.items ?? [], model.items),
      )
    else if (scrollFollow || this.transcriptWindowEnd === 0) {
      this.transcriptWindowEnd = model.items.length
      this.transcriptRowWindow = pinnedRowWindow
    } else
      this.transcriptWindowEnd =
        model.items.length <= maxMountedTranscriptEntries
          ? model.items.length
          : Math.min(this.transcriptWindowEnd, model.items.length)
    this.model = model
    this.queueHint.bg = cutoutBackground(this.renderer)
    this.modeLabel.bg = cutoutBackground(this.renderer)
    this.workspaceLabel.bg = cutoutBackground(this.renderer)
    this.statusLabel.bg = cutoutBackground(this.renderer)
    if (model.shortcutsOpen) this.setComposerResizePointer(false)
    const inputHeight = composerHeight(model)
    let renderedInputHeight = inputHeight
    if (model.shortcutsOpen) renderedInputHeight = Math.min(Math.max(1, model.height - 4), spacing.inputHeight + 12)
    else if (model.queue.length > 0) renderedInputHeight = Math.min(inputHeight, Math.max(1, model.height - 2))
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
        width: renderModel.width,
        windowEnd: this.transcriptWindowEnd,
        rowWindowEnd: this.transcriptRowWindow.end,
      }
      if (this.transcriptChanged(transcriptInput)) {
        const previousExpandedRows = this.transcriptRenderInput?.expandedRowKeys
        if (
          previousExpandedRows !== undefined &&
          (previousExpandedRows.length !== renderModel.expandedRowKeys.length ||
            previousExpandedRows.some((row) => !renderModel.expandedRowKeys.includes(row)))
        )
          this.renderer.clearSelection()
        const toolSpinnerGlyph = this.toolSpinner.toBraille()
        const boundedModel = boundedTranscriptModel(renderModel, this.transcriptWindowEnd)
        const builder = transcriptUnitBuilder(boundedModel, toolSpinnerGlyph)
        const expandedSet = new Set(boundedModel.expandedRowKeys)
        const nextCache = new Map<string, TranscriptUnitCacheEntry>()
        const orderedBundles: Array<{ readonly gapBefore: boolean; readonly bundle: TranscriptRangeBundle }> = []
        let renderedUnits = 0
        for (const unit of transcriptUnits(boundedModel)) {
          if (!builder.isUnitVisible(unit)) continue
          renderedUnits += 1
          const gapBefore = renderedUnits > 1
          const unitKey = transcriptUnitId(boundedModel, unit)
          const revision = transcriptUnitRevision(boundedModel, unit, unitKey, expandedSet)
          const cached = this.transcriptUnitCache.get(unitKey)
          const entry =
            cached !== undefined && cached.revision === revision
              ? cached
              : this.buildTranscriptUnitBundles(builder, unit, revision, toolSpinnerGlyph)
          nextCache.set(unitKey, entry)
          for (const [index, bundle] of entry.bundles.entries())
            orderedBundles.push({ gapBefore: index === 0 && gapBefore, bundle })
        }
        this.transcriptUnitCache = nextCache
        const totalRows = orderedBundles.length
        const limit = maxMountedTranscriptRows
        let rowEnd = totalRows
        if (this.transcriptRowWindow.end !== 0) {
          const anchorIndex =
            this.transcriptRowWindow.anchorKey === undefined
              ? -1
              : orderedBundles.findIndex(({ bundle }) => bundle.key === this.transcriptRowWindow.anchorKey)
          rowEnd = relocateRowEnd(this.transcriptRowWindow, anchorIndex, totalRows, limit)
        }
        const previousSelection = this.transcriptRenderInput?.detailSelection
        if (renderModel.detailSelection !== undefined && renderModel.detailSelection !== previousSelection) {
          const selectionIndex = orderedBundles.findIndex(({ bundle }) => bundle.key === renderModel.detailSelection)
          const included = includeRowEnd(rowEnd, selectionIndex, totalRows, limit)
          if (included !== rowEnd) {
            rowEnd = included
            if (this.transcriptRowWindow.end === 0 && rowEnd < totalRows)
              this.transcriptRowWindow = { end: rowEnd, pendingDelta: 0 }
          }
        }
        const mounted =
          this.transcriptRowWindow.end === 0
            ? orderedBundles.slice(-limit)
            : orderedBundles.slice(rowWindowStart(rowEnd, limit), rowEnd)
        this.transcriptRowTotal = totalRows
        if (this.transcriptRowWindow.end !== 0)
          this.transcriptRowWindow = {
            end: rowEnd,
            pendingDelta: 0,
            ...(mounted[0] === undefined ? {} : { anchorKey: mounted[0].bundle.key }),
          }
        const descriptors: Array<TranscriptRenderableDescriptor> = []
        for (const { gapBefore, bundle } of mounted) {
          if (gapBefore)
            descriptors.push({
              key: `${bundle.key}:gap`,
              revision: "gap",
              content: new StyledText([fg(toOpenColor(colors.text))(" ")]),
            })
          descriptors.push(...bundle.descriptors)
        }
        this.reconcileTranscript(descriptors)
        this.transcriptRenderInput = { ...transcriptInput, rowWindowEnd: this.transcriptRowWindow.end }
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
      this.welcomeStopTimer = this.delayed(1600, () => {
        this.cancelTimer(this.welcomeTimer)
        this.welcomeTimer = undefined
        this.welcomeStopTimer = undefined
      })
    } else if ((this.options.animate === false || !animateWelcome) && this.welcomeTimer !== undefined) {
      this.cancelTimer(this.welcomeTimer)
      this.welcomeTimer = undefined
      this.cancelTimer(this.welcomeStopTimer)
      this.welcomeStopTimer = undefined
    }
    const queue = model.queue as ReadonlyArray<QueueItem>
    const pendingSteering = model.pendingSteering
    this.queueBox.marginLeft = contentWidth <= 4 ? 0 : 1
    this.queueBox.marginRight = contentWidth <= 4 ? 0 : 1
    this.queueBox.visible = queue.length > 0 || pendingSteering.length > 0
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
    const steeringLabels = pendingSteering.map((row) => {
      const firstLine = row.text.split("\n")[0] ?? ""
      const label = `steering: ${firstLine}`
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
    for (const [steeringIndex, steeringLabel] of steeringLabels.entries()) {
      if (renderedRows >= availableRows) break
      queueChunks.push(fg(toOpenColor(colors.muted))(steeringLabel))
      renderedRows += 1
      if (steeringIndex < steeringLabels.length - 1 || queueLength > 0)
        queueChunks.push(fg(toOpenColor(colors.text))("\n"))
    }
    hintTop = renderedRows
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
    this.queueText.content = new StyledText(queueChunks)
    this.queueHint.top = hintTop
    const hintChunks: Array<TextChunk> = []
    for (const [index, segment] of hintSegments.entries()) {
      hintChunks.push(dim(fg(toOpenColor(colors.text))(index === 0 ? " " : " · ")))
      hintChunks.push(fg(colors[model.mode])(segment.accent))
      if (segment.suffix.length > 0) hintChunks.push(dim(fg(toOpenColor(colors.text))(segment.suffix)))
    }
    if (hintSegments.length > 0) hintChunks.push(dim(fg(toOpenColor(colors.text))(" ")))
    this.queueHint.content = new StyledText(hintChunks)
    this.queueHint.visible = hintSegments.length > 0
    this.queueLeftJoint.visible = queue.length > 0 || pendingSteering.length > 0
    this.queueRightJoint.visible = queue.length > 0 || pendingSteering.length > 0
    this.inputBox.borderColor = toOpenColor(colors.text)
    this.inputBox.title = ""
    this.modeLabel.right = sidebarWidth + 2
    this.renderModeLabel(model)
    const workspaceTitle = isNarrow(model)
      ? ""
      : ` ${compactWorkspace(model.workspace)}${model.branch === undefined ? "" : ` (${model.branch})`} `
    const panelLoadingLabel = panelLoading(model)
    const activityLabel = formatActivity(model.activity)
    if (activityLabel !== undefined || panelLoadingLabel !== undefined) {
      const statusName = activityLabel ?? panelLoadingLabel!
      this.inputBox.bottomTitle = ""
      this.statusLabel.content = new StyledText([
        fg(toOpenColor(colors.text))(" "),
        fg(toOpenColor(colors.blue))(loaderFrame(statusName, this.loaderPhase)),
        dim(fg(toOpenColor(colors.text))(` ${statusName} `)),
      ])
    } else {
      this.inputBox.bottomTitle = ""
      this.statusLabel.content = ""
    }
    this.workspaceLabel.right = sidebarWidth + 2
    this.workspaceLabel.content = new StyledText([dim(fg(toOpenColor(colors.text))(workspaceTitle))])
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
    if (preserveTranscriptPosition) {
      const pending = this.pendingTranscriptPosition
      const position =
        pending?._tag === "Anchor" && pending.threadId === model.currentThreadId
          ? {
              _tag: "Anchor" as const,
              anchor: pending.anchor,
              threadId: pending.threadId,
              scrollHeight: pending.scrollHeight,
              scrollBy: pending.scrollBy + this.transcriptAnchorScrollBy,
              nearBottom: this.transcriptAnchorScrollBy === 0 ? pending.nearBottom : this.transcriptAnchorNearBottom,
            }
          : {
              _tag: "Anchor" as const,
              anchor: transcriptAnchor,
              threadId: model.currentThreadId,
              scrollHeight: previousScrollHeight,
              scrollBy: this.transcriptAnchorScrollBy,
              nearBottom: this.transcriptAnchorNearBottom,
            }
      this.transcriptAnchorScrollBy = 0
      this.transcriptAnchorNearBottom = false
      this.scheduleTranscriptPosition(position)
    } else if (this.pendingTranscriptPosition !== undefined) this.renderer.requestRender()
    else
      this.defer(() => {
        if (this.model !== undefined) this.syncTranscriptScrollbar()
      })
    const loaderActive =
      model.busy ||
      model.activity !== undefined ||
      panelLoadingLabel !== undefined ||
      (model.usageDisplay === "time" &&
        model.usageTime?._tag === "Available" &&
        model.usageTime.activeSince !== undefined) ||
      (model.threadSidebar.open &&
        (model.threads as ReadonlyArray<ThreadItem>).some((thread) => isThreadBusy(thread.status)))
    if (this.options.animate !== false && loaderActive && this.loaderTimer === undefined) {
      this.loaderTimer = this.clock.setInterval(() => this.tickLoader(), spinnerInterval)
    } else if ((this.options.animate === false || !loaderActive) && this.loaderTimer !== undefined) {
      this.clock.clearInterval(this.loaderTimer)
      this.loaderTimer = undefined
    }
    this.updateOverlay(model, contentLeft, contentWidth, renderedInputHeight, threadSidebarVisible)
  }
}
