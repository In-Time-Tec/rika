import { StyledText, fg, TextRenderable } from "@opentui/core"
import { mountedTranscriptRowBudget } from "../../presentation/transcript/terminal-transcript-window"
import { boundedTranscriptModel } from "../rendering/opentui-render-transcript-window"
import type { Model } from "../../state/model/terminal-state"
import type { TranscriptRenderableDescriptor } from "./opentui-surface-transcript-types"
import {
  contentColumnWidth,
  fileSidebarLayoutWidth,
  threadSidebarLayoutWidth,
} from "../../state/model/terminal-layout-state"
import { spacing, colors } from "../../presentation/terminal/terminal-theme"
import { toOpenColor } from "../rendering/terminal-text-adapter"
import { cutoutBackground } from "./opentui-surface-renderables"
import { welcomeContent } from "./opentui-surface-content"
import { welcomeVisible } from "./opentui-welcome-state"
import { composerHeight } from "../../state/model/terminal-layout-composer"
import { transcriptUnitId, transcriptUnits } from "../../presentation/transcript/transcript-row"
import {
  transcriptUnitRevision,
  type TranscriptRangeBundle,
  type TranscriptUnitCacheEntry,
} from "../rendering/opentui-render-transcript-revision"
import { transcriptUnitBuilder } from "../rendering/opentui-render-unit"
import { SurfaceModeLabel } from "./opentui-surface-mode-label"

export abstract class SurfaceTranscriptMount extends SurfaceModeLabel {
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
    this.goalLabel.bg = cutoutBackground(this.renderer)
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
    const isWelcome = welcomeVisible(model)
    this.transcriptScroll.content.justifyContent = isWelcome ? "flex-start" : "flex-end"
    if (isWelcome) {
      this.transcriptRenderInput = undefined
      this.transcriptRowTotal = 0
      const welcomeWidth = this.welcomeWidthFor(model)
      const welcomePhase = this.options.animate === false ? model.animationTick : this.welcomeController.phase
      const impulses = this.welcomeController.impulses
      const welcomeKey = `${welcomeWidth}:${model.height}:${welcomePhase}:${model.mode}:${impulses.length}`
      const existingWelcome = this.transcriptChildren.length === 1 ? this.welcomeController.child : undefined
      if (existingWelcome === undefined) {
        const child = new TextRenderable(this.renderer, {
          content: welcomeContent(welcomeWidth, model.height, welcomePhase, model.mode, impulses),
          fg: modeColor,
          wrapMode: "word",
          selectable: true,
        })
        child.onMouseDown = (event) => this.strikeWelcomeOrb(event)
        this.setWelcomeChild(child)
        this.welcomeController.child = child
        this.welcomeController.key = welcomeKey
      } else if (this.welcomeController.key !== welcomeKey) {
        this.welcomeController.key = welcomeKey
        existingWelcome.fg = modeColor
        existingWelcome.content = welcomeContent(welcomeWidth, model.height, welcomePhase, model.mode, impulses)
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
        const orderedBundles: Array<{
          readonly gapBefore: boolean
          readonly rows: number
          readonly bundle: TranscriptRangeBundle
        }> = []
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
            orderedBundles.push({
              gapBefore: index === 0 && gapBefore,
              rows: bundle.rows + (index === 0 && gapBefore ? 1 : 0),
              bundle,
            })
        }
        this.transcriptUnitCache = nextCache
        const prefix: Array<number> = [0]
        for (const current of orderedBundles) prefix.push(prefix.at(-1)! + current.rows)
        const totalRows = prefix.at(-1) ?? 0
        let bandEnd = Math.min(
          orderedBundles.length,
          Number.isFinite(this.transcriptBandEnd)
            ? Math.max(0, Math.floor(this.transcriptBandEnd))
            : orderedBundles.length,
        )
        const budget = mountedTranscriptRowBudget(
          this.transcriptScroll.viewport.height > 0 ? this.transcriptScroll.viewport.height : model.height,
        )
        if (totalRows <= budget) bandEnd = orderedBundles.length
        if (totalRows > budget && this.transcriptMountAnchorKey !== undefined) {
          const anchorBand = orderedBundles.findIndex((current) =>
            current.bundle.descriptors.some((descriptor) => descriptor.key === this.transcriptMountAnchorKey),
          )
          if (anchorBand >= 0) bandEnd = anchorBand + 1
        }
        let bandStart = bandEnd
        if (this.transcriptBandTargetTop !== undefined) {
          let low = 0
          let high = bandEnd
          while (low < high) {
            const middle = (low + high) >> 1
            if (prefix[middle + 1]! <= this.transcriptBandTargetTop) low = middle + 1
            else high = middle
          }
          bandStart = Math.min(low, Math.max(0, bandEnd - 1))
        } else
          while (bandStart > 0 && (bandStart === bandEnd || prefix[bandEnd]! - prefix[bandStart]! < budget))
            bandStart -= 1
        const selection = this.renderer.getSelection()
        const selected = new Set(selection?.touchedRenderables ?? [])
        if (selected.size > 0) {
          const bandByKey = new Map<string, number>()
          for (const [index, current] of orderedBundles.entries())
            for (const descriptor of current.bundle.descriptors) bandByKey.set(descriptor.key, index)
          for (const record of this.transcriptRecords.values()) {
            if (!selected.has(record.renderable)) continue
            const index = bandByKey.get(record.key)
            if (index === undefined) continue
            bandStart = Math.min(bandStart, index)
            bandEnd = Math.max(bandEnd, index + 1)
          }
        }
        const mounted = orderedBundles.slice(bandStart, bandEnd)
        const topSpacerRows = prefix[bandStart] ?? 0
        const bottomSpacerRows = Math.max(0, totalRows - (prefix[bandEnd] ?? totalRows))
        this.transcriptTopSpacer.height = topSpacerRows
        this.transcriptTopSpacer.visible = topSpacerRows > 0
        this.transcriptBottomSpacer.height = bottomSpacerRows
        this.transcriptBottomSpacer.visible = bottomSpacerRows > 0
        this.transcriptBandEnd = bandEnd
        this.transcriptBandTotal = orderedBundles.length
        this.transcriptMountedBandStart = bandStart
        this.transcriptBandRowsBefore = prefix[bandStart] ?? 0
        this.transcriptBandRowsAfter = Math.max(0, totalRows - (prefix[bandEnd] ?? totalRows))
        this.transcriptMountedRows = (prefix[bandEnd] ?? 0) - this.transcriptBandRowsBefore
        this.transcriptWindowExactRows = totalRows
        this.transcriptBandRowPrefix = prefix
        this.transcriptRowTotal = totalRows
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
        this.transcriptRenderInput = transcriptInput
      }
    }
    return { sidebarWidth, contentLeft, contentWidth, renderedInputHeight, sidebarVisible, threadSidebarVisible }
  }
}
