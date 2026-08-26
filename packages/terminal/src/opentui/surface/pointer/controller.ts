import type { MousePointerStyle } from "@opentui/core"

export interface DragState {
  readonly startY: number
  readonly startHeight: number
}

export interface SidebarDragState {
  readonly startX: number
  readonly startWidth: number
}

export class PointerController {
  public composerDrag: DragState | undefined
  public sidebarDrag: SidebarDragState | undefined
  private pointerStyle: MousePointerStyle = "default"

  get dragging(): boolean {
    return this.composerDrag !== undefined || this.sidebarDrag !== undefined
  }

  changePointerStyle(pointerStyle: MousePointerStyle): boolean {
    if (this.pointerStyle === pointerStyle) return false
    this.pointerStyle = pointerStyle
    return true
  }

  release(): void {
    this.composerDrag = undefined
    this.sidebarDrag = undefined
  }
}
