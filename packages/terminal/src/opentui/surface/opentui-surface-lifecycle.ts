import { CliRenderEvents } from "@opentui/core"
import type { Model } from "../../state/model/terminal-state"
import { restingFrame } from "../rendering/opentui-animation-frame"
import { SurfaceLayout } from "./opentui-surface-layout"

export abstract class SurfaceLifecycle extends SurfaceLayout {
  update(model: Model, preserveTranscriptAnchor = false): void {
    const previousModel = this.model
    if (model.busy && previousModel?.busy !== true) this.publishWorkingFrame(restingFrame)
    else if (!model.busy && previousModel?.busy === true) this.publishWorkingFrame(undefined)
    const transcriptLayout = this.renderTranscript(model, preserveTranscriptAnchor)
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
    if (this.animationShouldRun(model)) this.animation.start()
    else this.animation.stop()
    this.updateOverlay(
      model,
      transcriptLayout.contentLeft,
      transcriptLayout.contentWidth,
      transcriptLayout.renderedInputHeight,
    )
    this.renderer.requestRender()
  }
  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.animation.stop()
    this.welcomeController.release()
    if (this.publishedFrame !== undefined) this.publishWorkingFrame(undefined)
    this.sidebarController.release()
    this.hoverController.release()
    this.toastController.release()
    this.cancelTimer(this.junkTimer)
    this.junkTimer = undefined
    this.junkBuffer = []
    this.composerEditor.blur()
    this.overlayEditor.blur()
    this.pointerController.composerDrag = undefined
    this.pointerController.sidebarDrag = undefined
    this.setPointerShape("default")
    this.model = undefined
    this.transcriptPane.destroy()
    this.threadBrowser.destroy()
    this.renderer.root.onMouseDrag = undefined
    this.renderer.root.onMouseUp = undefined
    this.renderer.root.onMouseDragEnd = undefined
    this.renderer.keyInput.off("keypress", this.onKey)
    this.renderer.keyInput.off("paste", this.onPaste)
    this.renderer.off(CliRenderEvents.RESIZE, this.onResize)
    this.renderer.off(CliRenderEvents.SELECTION, this.onSelection)
  }
}
