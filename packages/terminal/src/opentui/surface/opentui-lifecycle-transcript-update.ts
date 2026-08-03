import { TextRenderable, StyledText, fg } from "@opentui/core"
import {
  contentColumnWidth,
  fileSidebarLayoutWidth,
  threadSidebarLayoutWidth,
} from "../../state/model/terminal-layout-state"
import type { Model } from "../../state/model/terminal-state"
import { composerHeight } from "../../state/model/terminal-layout-composer"
import { colors, spacing } from "../../presentation/terminal/terminal-theme"
import { toOpenColor } from "../rendering/terminal-text-adapter"
import {
  maxMountedTranscriptRows,
  relocateRowEnd,
  rowWindowStart,
} from "../../presentation/transcript/terminal-transcript-window"
import { includeRowEnd } from "../../presentation/transcript/transcript-row-window-include"
import { transcriptUnitId, transcriptUnits } from "../../presentation/transcript/transcript-row"
import { boundedTranscriptModel } from "../rendering/opentui-render-transcript-window"
import { transcriptUnitRevision } from "../rendering/opentui-render-transcript-revision"
import { transcriptUnitBuilder } from "../rendering/opentui-render-unit"
import type { TranscriptRangeBundle, TranscriptUnitCacheEntry } from "../rendering/opentui-render-transcript-revision"
import { animationActive, welcomeContent } from "./opentui-surface-content"
import { cutoutBackground } from "./opentui-surface-construction"
import type { TranscriptRenderableDescriptor } from "./opentui-surface-transcript-types"
import { SurfaceLifecycleToast } from "./opentui-lifecycle-toast"

export abstract class SurfaceLifecycleTranscript extends SurfaceLifecycleToast {
  protected renderTranscript(model: Model): {
    readonly sidebarWidth: number
    readonly contentLeft: number
    readonly contentWidth: number
    readonly renderedInputHeight: number
    readonly sidebarVisible: boolean
    readonly threadSidebarVisible: boolean
  } {
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
    if (isWelcome) {
      this.transcriptRenderInput = undefined
      const welcomeWidth = this.welcomeWidthFor(model)
      const welcomePhase = animationActive(model) ? model.animationTick : 0
      const welcomeKey = `${welcomeWidth}:${model.height}:${welcomePhase}:${model.mode}`
      const existingWelcome = this.transcriptChildren.length === 1 ? this.welcomeChild : undefined
      if (existingWelcome === undefined) {
        const child = new TextRenderable(this.renderer, {
          content: welcomeContent(welcomeWidth, model.height, welcomePhase, model.mode),
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
        existingWelcome.content = welcomeContent(welcomeWidth, model.height, welcomePhase, model.mode)
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
        animationTick: model.animationTick,
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
    return { sidebarWidth, contentLeft, contentWidth, renderedInputHeight, sidebarVisible, threadSidebarVisible }
  }
}
