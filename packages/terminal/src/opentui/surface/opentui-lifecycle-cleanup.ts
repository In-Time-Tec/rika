import { CliRenderEvents } from "@opentui/core"
import { SurfaceLifecycle } from "./opentui-lifecycle"

export abstract class SurfaceLifecycleCleanup extends SurfaceLifecycle {
  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    if (this.loaderTimer !== undefined) this.clock.clearInterval(this.loaderTimer)
    this.loaderTimer = undefined
    if (this.publishedWorkingFrame !== undefined) this.publishWorkingFrame(undefined)
    this.scrollGeneration += 1
    if (this.cursorRestoreFrame !== undefined) this.renderer.off(CliRenderEvents.FRAME, this.cursorRestoreFrame)
    this.cursorRestoreFrame = undefined
    if (this.transcriptPositionFrame !== undefined)
      this.renderer.off(CliRenderEvents.FRAME, this.transcriptPositionFrame)
    this.transcriptPositionFrame = undefined
    this.renderer.off(CliRenderEvents.FRAME, this.recordRenderedTranscriptScroll)
    if (this.sidebarLayoutFrame !== undefined) this.renderer.off(CliRenderEvents.FRAME, this.sidebarLayoutFrame)
    this.sidebarLayoutFrame = undefined
    if (this.usageLayoutFrame !== undefined) this.renderer.off(CliRenderEvents.FRAME, this.usageLayoutFrame)
    this.usageLayoutFrame = undefined
    this.transcriptAnchorScrollBy = 0
    this.pendingTranscriptPosition = undefined
    this.cancelWheelReport()
    this.cancelTimer(this.welcomeTimer)
    this.welcomeTimer = undefined
    this.cancelTimer(this.welcomeStopTimer)
    this.welcomeStopTimer = undefined
    this.cancelTimer(this.toastTimer)
    this.toastTimer = undefined
    this.cancelTimer(this.junkTimer)
    this.junkTimer = undefined
    this.junkBuffer = []
    this.focusEditor(undefined)
    this.composerDrag = undefined
    this.sidebarDrag = undefined
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
