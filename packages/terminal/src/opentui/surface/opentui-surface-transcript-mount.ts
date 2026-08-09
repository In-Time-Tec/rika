import { StyledText, fg, TextRenderable } from "@opentui/core"
import { maxMountedTranscriptRows } from "../../presentation/transcript/terminal-transcript-window"
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
        const mounted = orderedBundles.slice(-maxMountedTranscriptRows)
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
