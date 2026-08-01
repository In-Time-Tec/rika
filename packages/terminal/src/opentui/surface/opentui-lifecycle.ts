import { CliRenderEvents } from "@opentui/core"
import type { Model } from "../../state/model/terminal-state"
import { contentColumnWidth } from "../../state/model/terminal-layout-state"
import { isThreadBusy } from "../../state/model/terminal-thread-predicate"
import { type ThreadItem } from "../../state/model/terminal-thread-state"
import { pinnedRowWindow } from "../../presentation/transcript/transcript-row-window-state"
import { isFollowing } from "../../presentation/transcript/transcript-viewport"
import { prependedTranscriptItems } from "./opentui-lifecycle-transcript"
import { maxMountedTranscriptEntries } from "../rendering/opentui-render-transcript-window"
import { idleSpinnerFrame, spinnerInterval } from "../rendering/opentui-spinner"
import { SurfaceLifecycleTranscript } from "./opentui-lifecycle-transcript-update"
import { panelLoading } from "./opentui-surface-content"

export abstract class SurfaceLifecycle extends SurfaceLifecycleTranscript {
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
    const panelLoadingLabel = panelLoading(model)
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
