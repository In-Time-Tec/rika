import { CliRenderEvents, type CliRenderer, type StyledText } from "@opentui/core"
import { renderFileRows, sidebarFileRows, sidebarInnerWidth } from "../rendering/opentui-render-block"
import type { Model } from "../../state/model/terminal-state"
import type { ChangedFileRow } from "./opentui-surface-transcript-types"

export interface SidebarBox {
  readonly visible: boolean
  readonly viewport: { readonly height: number }
  readonly scrollTop: number
  setVirtualHeight(value: number): void
  syncVirtualScroll(): void
}

export interface SidebarText {
  content: StyledText
}

export interface SidebarHost {
  readonly renderer: CliRenderer
  readonly box: SidebarBox
  readonly text: SidebarText
  readonly model: () => Model | undefined
  readonly dragging: () => boolean
  readonly destroyed: () => boolean
  readonly hoveredRow: () => number | undefined
}

export class SidebarController {
  private view: "changed" | "workspace" | undefined
  private source: unknown
  private width = 0

  public windowStart = -1
  private windowEnd = -1
  private windowHoveredRow: number | undefined
  private layoutFrame: (() => void) | undefined
  public rows: ReadonlyArray<ChangedFileRow> = []

  constructor(private readonly host: SidebarHost) {}

  refreshRows(model: Model): void {
    const view = model.changedFilesOpen ? "changed" : "workspace"
    const source = view === "changed" ? model.changedFiles : model.filePicker.items
    const width = sidebarInnerWidth(model)
    if (this.view !== view || this.source !== source || (!this.host.dragging() && this.width !== width)) {
      this.view = view
      this.source = source
      this.width = width
      this.rows = sidebarFileRows(model, width)
      this.host.box.setVirtualHeight(this.rows.length)
      this.windowStart = -1
      this.windowEnd = -1
    }
    this.refreshWindow()
  }

  refreshWindow(force = false): boolean {
    if (!this.host.box.visible) return false
    const viewportRows = Math.max(1, this.host.box.viewport.height || (this.host.model()?.height ?? 1) - 2)
    const scrollTop = Math.min(
      Math.max(0, Math.floor(this.host.box.scrollTop)),
      Math.max(0, this.rows.length - viewportRows),
    )
    const end = Math.min(this.rows.length, scrollTop + viewportRows)
    const hovered = this.host.hoveredRow()
    if (!force && scrollTop === this.windowStart && end === this.windowEnd && hovered === this.windowHoveredRow)
      return false
    this.windowStart = scrollTop
    this.windowEnd = end
    this.windowHoveredRow = hovered
    this.host.text.content = renderFileRows(
      this.rows.slice(scrollTop, end),
      hovered === undefined ? undefined : hovered - scrollTop,
    )
    return true
  }

  refreshAfterLayout(): void {
    if (this.layoutFrame !== undefined) return
    const refresh = () => {
      this.host.renderer.off(CliRenderEvents.FRAME, refresh)
      this.layoutFrame = undefined
      if (this.host.destroyed()) return
      this.host.box.syncVirtualScroll()
      if (this.refreshWindow()) this.host.renderer.requestRender()
    }
    this.layoutFrame = refresh
    this.host.renderer.on(CliRenderEvents.FRAME, refresh)
  }

  invalidateWidth(): void {
    this.width = 0
  }

  release(): void {
    if (this.layoutFrame === undefined) return
    this.host.renderer.off(CliRenderEvents.FRAME, this.layoutFrame)
    this.layoutFrame = undefined
  }
}
