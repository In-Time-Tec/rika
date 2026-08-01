import { CliRenderEvents } from "@opentui/core"
import { sidebarFileRows, sidebarInnerWidth, renderFileRows } from "../rendering/opentui-render-block"
import { SurfaceTranscriptRegion } from "./opentui-transcript-region"
import type { Model } from "../../state/model/terminal-state"
import { contentColumnWidth } from "../../state/model/terminal-state"
import { spacing } from "../../presentation/terminal/terminal-theme"

export abstract class SurfaceSidebarRegion extends SurfaceTranscriptRegion {
  protected refreshSidebarRows(model: Model): void {
    const view = model.changedFilesOpen ? "changed" : "workspace"
    const source = view === "changed" ? model.changedFiles : model.filePicker.items
    const width = sidebarInnerWidth(model)
    if (
      this.sidebarRowsView !== view ||
      this.sidebarRowsSource !== source ||
      (this.sidebarDrag === undefined && this.sidebarRowsWidth !== width)
    ) {
      this.sidebarRowsView = view
      this.sidebarRowsSource = source
      this.sidebarRowsWidth = width
      this.changedRows = sidebarFileRows(model, width)
      this.changedFilesBox.setVirtualHeight(this.changedRows.length)
      this.sidebarWindowStart = -1
      this.sidebarWindowEnd = -1
    }
    this.refreshSidebarWindow()
  }
  protected refreshSidebarWindow(force = false): boolean {
    if (!this.changedFilesBox.visible) return false
    const viewportRows = Math.max(1, this.changedFilesBox.viewport.height || (this.model?.height ?? 1) - 2)
    const scrollTop = Math.min(
      Math.max(0, Math.floor(this.changedFilesBox.scrollTop)),
      Math.max(0, this.changedRows.length - viewportRows),
    )
    const start = scrollTop
    const end = Math.min(this.changedRows.length, scrollTop + viewportRows)
    if (
      !force &&
      start === this.sidebarWindowStart &&
      end === this.sidebarWindowEnd &&
      this.changedFilesHoveredRow === this.sidebarWindowHoveredRow
    )
      return false
    this.sidebarWindowStart = start
    this.sidebarWindowEnd = end
    this.sidebarWindowHoveredRow = this.changedFilesHoveredRow
    this.changedFilesText.content = renderFileRows(
      this.changedRows.slice(start, end),
      this.changedFilesHoveredRow === undefined ? undefined : this.changedFilesHoveredRow - start,
    )
    return true
  }
  protected refreshSidebarAfterLayout(): void {
    if (this.sidebarLayoutFrame !== undefined) return
    const refresh = () => {
      this.renderer.off(CliRenderEvents.FRAME, refresh)
      this.sidebarLayoutFrame = undefined
      if (this.destroyed) return
      this.changedFilesBox.syncVirtualScroll()
      if (this.refreshSidebarWindow()) this.renderer.requestRender()
    }
    this.sidebarLayoutFrame = refresh
    this.renderer.on(CliRenderEvents.FRAME, refresh)
  }
  protected welcomeWidthFor(model: Model): number {
    return Math.max(1, contentColumnWidth(model) - spacing.transcript * 2)
  }
}
