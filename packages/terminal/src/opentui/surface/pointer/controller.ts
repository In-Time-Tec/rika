export interface DragState {
  readonly startY: number
  readonly startHeight: number
}

export interface SidebarDragState {
  readonly startX: number
  readonly startWidth: number
}

export type PointerShape = "ns-resize" | "ew-resize" | "default"

export class PointerController {
  public composerDrag: DragState | undefined
  public sidebarDrag: SidebarDragState | undefined
  private shape: PointerShape = "default"

  get dragging(): boolean {
    return this.composerDrag !== undefined || this.sidebarDrag !== undefined
  }

  changeShape(shape: PointerShape): boolean {
    if (this.shape === shape) return false
    this.shape = shape
    return true
  }

  release(): void {
    this.composerDrag = undefined
    this.sidebarDrag = undefined
  }
}
