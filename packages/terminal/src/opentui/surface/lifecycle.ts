import { CliRenderEvents } from "@opentui/core"
import type { Model } from "../../state/model"
import { idleSpinnerFrame, spinnerInterval } from "../rendering/spinner"
import { animationActive } from "./content"
import { welcomeAnimationActive } from "./welcome/state"
import { SurfaceLayout } from "./layout"
import { Warning } from "../../warning"

export abstract class SurfaceLifecycle extends SurfaceLayout {
  protected guardedOnKey!: typeof this.onKey
  protected guardedOnPaste!: typeof this.onPaste
  protected guardedOnResize!: typeof this.onResize
  protected guardedOnSelection!: typeof this.onSelection
  protected guardedOnRootMouseDrag!: typeof this.onRootMouseDrag
  protected guardedOnRootMouseUp!: typeof this.onRootMouseUp

  protected guardCallback<Args extends Array<unknown>>(
    event: string,
    callback: (...args: Args) => void,
  ): (...args: Args) => void {
    return (...args) => {
      try {
        callback(...args)
      } catch (cause) {
        Warning.log(`tui.callback.${event}.failed`, cause)
        if (!this.destroyed) this.renderer.requestRender()
      }
    }
  }

  protected initializeGuardedCallbacks(): void {
    this.guardedOnKey = this.guardCallback("keypress", this.onKey)
    this.guardedOnPaste = this.guardCallback("paste", this.onPaste)
    this.guardedOnResize = this.guardCallback("resize", this.onResize)
    this.guardedOnSelection = this.guardCallback("selection", this.onSelection)
    this.guardedOnRootMouseDrag = this.guardCallback("mouse_drag", this.onRootMouseDrag)
    this.guardedOnRootMouseUp = this.guardCallback("mouse_up", this.onRootMouseUp)
  }

  onNextFrameCompleted(listener: () => void): void {
    this.renderer.once(CliRenderEvents.FRAME, listener)
  }

  private updateAnimations(model: Model): void {
    const enabled = this.options.animate !== false
    if (enabled && animationActive(model)) this.loaderController.start(spinnerInterval, () => this.tickLoader())
    else this.loaderController.stop()
    if (enabled && welcomeAnimationActive(model))
      this.welcomeController.start(spinnerInterval, () => this.tickWelcome())
    else this.welcomeController.stop()
  }

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
    this.updateAnimations(model)
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
    this.setPointerCursor("default")
    this.model = undefined
    this.renderer.root.onMouseDrag = undefined
    this.renderer.root.onMouseUp = undefined
    this.renderer.root.onMouseDragEnd = undefined
    this.renderer.keyInput.off("keypress", this.guardedOnKey)
    this.renderer.keyInput.off("paste", this.guardedOnPaste)
    this.renderer.off(CliRenderEvents.RESIZE, this.guardedOnResize)
    this.renderer.off(CliRenderEvents.SELECTION, this.guardedOnSelection)
    this.transcriptPane.destroy()
    this.threadBrowser.destroy()
    for (const renderable of [
      this.main,
      this.modeLabel,
      this.statusLabel,
      this.workspaceLabel,
      this.paletteBox,
      this.overlayHintOne,
      this.overlayHintTwo,
      this.toastBox,
      this.ctrlCMenuBox,
      this.ctrlCMenuTitle,
    ]) {
      renderable.destroyRecursively()
    }
    this.releaseWarningReporter()
  }
}
