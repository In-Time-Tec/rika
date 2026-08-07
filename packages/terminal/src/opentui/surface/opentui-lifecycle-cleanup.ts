import { CliRenderEvents } from "@opentui/core"
import { SurfaceLifecycle } from "./opentui-lifecycle"

export abstract class SurfaceLifecycleCleanup extends SurfaceLifecycle {
  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.loaderController.release()
    this.welcomeController.release()
    if (this.loaderController.publishedFrame !== undefined) this.publishWorkingFrame(undefined)
    this.scrollGeneration += 1
    this.focusController.release()
    if (this.transcriptPositionFrame !== undefined)
      this.renderer.off(CliRenderEvents.FRAME, this.transcriptPositionFrame)
    this.transcriptPositionFrame = undefined
    this.renderer.off(CliRenderEvents.FRAME, this.recordRenderedTranscriptScroll)
    this.sidebarController.release()
    this.hoverController.release()
    this.transcriptAnchorScrollBy = 0
    this.pendingTranscriptPosition = undefined
    this.cancelWheelReport()
    this.toastController.release()
    this.cancelTimer(this.junkTimer)
    this.junkTimer = undefined
    this.junkBuffer = []
    this.focusEditor(undefined)
    this.pointerController.composerDrag = undefined
    this.pointerController.sidebarDrag = undefined
    this.setPointerShape("default")
    this.model = undefined
    this.clearTranscriptChildren()
    this.renderer.root.onMouseDrag = undefined
    this.renderer.root.onMouseUp = undefined
    this.renderer.root.onMouseDragEnd = undefined
    this.renderer.keyInput.off("keypress", this.onKey)
    this.renderer.keyInput.off("paste", this.onPaste)
    this.renderer.off(CliRenderEvents.RESIZE, this.onResize)
    this.renderer.off(CliRenderEvents.SELECTION, this.onSelection)
  }
}
