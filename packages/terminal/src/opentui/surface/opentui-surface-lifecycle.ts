import { CliRenderEvents } from "@opentui/core"
import type { Model } from "../../state/model/terminal-state"
import { idleSpinnerFrame, spinnerInterval } from "../rendering/opentui-spinner"
import { animationActive, goalAnimationActive } from "./opentui-surface-content"
import { welcomeAnimationActive, welcomeAnimationSettled } from "./opentui-welcome-state"
import { SurfaceLayout } from "./opentui-surface-layout"

export abstract class SurfaceLifecycle extends SurfaceLayout {
  update(model: Model, preserveTranscriptAnchor = false): void {
    const previousModel = this.model
    if (model.busy && previousModel?.busy !== true) this.publishWorkingFrame(idleSpinnerFrame)
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
    const loaderActive = animationActive(model)
    if (this.options.animate !== false && loaderActive) {
      this.loaderController.start(spinnerInterval, () => this.tickLoader())
    } else if (this.options.animate === false || !loaderActive) this.loaderController.stop()
    const welcomeActive =
      welcomeAnimationActive(model) &&
      !welcomeAnimationSettled(this.welcomeController.phase, this.welcomeController.impulses)
    if (this.options.animate !== false && welcomeActive) {
      this.welcomeController.start(spinnerInterval, () => this.tickWelcome())
    } else if (this.options.animate === false || !welcomeActive) this.welcomeController.stop()
    const goalActive = goalAnimationActive(model)
    if (this.options.animate !== false && goalActive) this.goalController.start(spinnerInterval, () => this.tickGoal())
    else if (this.options.animate === false || !goalActive) this.goalController.stop()
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
    this.loaderController.release()
    this.welcomeController.release()
    this.goalController.release()
    if (this.loaderController.publishedFrame !== undefined) this.publishWorkingFrame(undefined)
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
