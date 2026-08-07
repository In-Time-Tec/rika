import { CliRenderEvents } from "@opentui/core"
import type { Model } from "../../state/model/terminal-state"
import { contentColumnWidth } from "../../state/model/terminal-layout-state"
import { isFollowing } from "../../presentation/transcript/transcript-viewport"
import { prependedTranscriptItems } from "./opentui-lifecycle-transcript"
import { maxMountedTranscriptEntries } from "../rendering/opentui-render-transcript-window"
import { idleSpinnerFrame, spinnerInterval } from "../rendering/opentui-spinner"
import { SurfaceLifecycleTranscript } from "./opentui-lifecycle-transcript-update"
import { animationActive } from "./opentui-surface-content"
import { welcomeAnimationActive } from "./opentui-welcome-state"

export abstract class SurfaceLifecycle extends SurfaceLifecycleTranscript {
  protected readonly onSelection = (selection: { getSelectedText: () => string }) => {
    const text = selection.getSelectedText().trimEnd()
    if (text.length === 0) return
    this.renderer.copyToClipboardOSC52(text)
    this.showToast("Selection copied to clipboard")
  }

  update(model: Model, preserveTranscriptAnchor = false): void {
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
      this.transcriptRowTotal = 0
    } else if (preserveTranscriptAnchor)
      this.transcriptWindowEnd = Math.min(
        model.items.length,
        this.transcriptWindowEnd + prependedTranscriptItems(previousModel?.items ?? [], model.items),
      )
    else if (scrollFollow || this.transcriptWindowEnd === 0) {
      this.transcriptWindowEnd = model.items.length
    } else
      this.transcriptWindowEnd =
        model.items.length <= maxMountedTranscriptEntries
          ? model.items.length
          : Math.min(this.transcriptWindowEnd, model.items.length)
    const transcriptLayout = this.renderTranscript(model)
    this.renderLayout(
      model,
      previousModel,
      transcriptLayout.sidebarWidth,
      transcriptLayout.contentLeft,
      transcriptLayout.contentWidth,
      transcriptLayout.renderedInputHeight,
      transcriptLayout.sidebarVisible,
      transcriptLayout.threadSidebarVisible,
    )
    if (preserveTranscriptPosition) {
      const pending = this.pendingTranscriptPosition
      const position =
        pending?._tag === "Anchor" && pending.threadId === model.currentThreadId
          ? {
              _tag: "Anchor" as const,
              anchor: pending.anchor,
              threadId: pending.threadId,
              scrollBy: pending.scrollBy + this.transcriptAnchorScrollBy,
              nearBottom: this.transcriptAnchorScrollBy === 0 ? pending.nearBottom : this.transcriptAnchorNearBottom,
            }
          : {
              _tag: "Anchor" as const,
              anchor: transcriptAnchor,
              threadId: model.currentThreadId,
              scrollBy: this.transcriptAnchorScrollBy,
              nearBottom: this.transcriptAnchorNearBottom,
            }
      this.transcriptAnchorScrollBy = 0
      this.transcriptAnchorNearBottom = false
      this.scheduleTranscriptPosition(position)
    } else if (this.pendingTranscriptPosition !== undefined) this.renderer.requestRender()
    else if (!this.transcriptScrollbarSyncPending) {
      this.transcriptScrollbarSyncPending = true
      this.defer(() => {
        this.transcriptScrollbarSyncPending = false
        if (this.model !== undefined) this.syncTranscriptScrollbar()
      })
    }
    const loaderActive = animationActive(model)
    if (this.options.animate !== false && loaderActive) {
      this.loaderController.start(spinnerInterval, () => this.tickLoader())
    } else if (this.options.animate === false || !loaderActive) this.loaderController.stop()
    const welcomeActive = welcomeAnimationActive(model)
    if (this.options.animate !== false && welcomeActive) {
      this.welcomeController.start(spinnerInterval, () => this.tickWelcome())
    } else if (this.options.animate === false || !welcomeActive) this.welcomeController.stop()
    this.updateOverlay(
      model,
      transcriptLayout.contentLeft,
      transcriptLayout.contentWidth,
      transcriptLayout.renderedInputHeight,
      transcriptLayout.threadSidebarVisible,
    )
    this.renderer.requestRender()
  }
}
