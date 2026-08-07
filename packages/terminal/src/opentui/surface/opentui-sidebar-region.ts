import { SurfaceTranscriptRegion } from "./opentui-transcript-region"
import { SidebarController } from "./opentui-sidebar-controller"
import type { Model } from "../../state/model/terminal-state"
import type { ChangedFileRow } from "./opentui-surface-transcript-types"
import { contentColumnWidth } from "../../state/model/terminal-layout-state"
import { spacing } from "../../presentation/terminal/terminal-theme"

export abstract class SurfaceSidebarRegion extends SurfaceTranscriptRegion {
  protected sidebarController!: SidebarController
  protected initializeSidebar(): void {
    this.sidebarController = new SidebarController({
      renderer: this.renderer,
      box: this.changedFilesBox,
      text: this.changedFilesText,
      model: () => this.model,
      dragging: () => this.sidebarDrag !== undefined,
      destroyed: () => this.destroyed,
      hoveredRow: () => this.changedFilesHoveredRow,
    })
  }
  protected refreshSidebarRows(model: Model): void {
    this.sidebarController.refreshRows(model)
  }
  protected refreshSidebarWindow(force = false): boolean {
    return this.sidebarController.refreshWindow(force)
  }
  protected refreshSidebarAfterLayout(): void {
    this.sidebarController.refreshAfterLayout()
  }
  public sidebarRows(): ReadonlyArray<ChangedFileRow> {
    return this.sidebarController.rows
  }
  protected welcomeWidthFor(model: Model): number {
    return Math.max(1, contentColumnWidth(model) - spacing.transcript * 2)
  }
}
