import { CliRenderEvents, type CliRenderer } from "@opentui/core"

export interface HoverHost {
  readonly renderer: CliRenderer
  readonly destroyed: () => boolean
}

export class HoverController {
  public usageWidth = 0
  public usageHovered = false
  public modeHovered = false
  public modeSegmentStart = 0
  public pointerX: number | undefined
  private layoutFrame: (() => void) | undefined

  constructor(private readonly host: HoverHost) {}

  measure(usageWidth: number): void {
    this.usageWidth = usageWidth
    this.modeSegmentStart = usageWidth === 0 ? 0 : usageWidth + 1
  }

  hoveredAt(screenX: number, pointerX: number | undefined): boolean {
    if (pointerX === undefined) return false
    return pointerX >= screenX && pointerX < screenX + this.usageWidth
  }

  applyHover(hovered: boolean): boolean {
    if (hovered === this.usageHovered) return false
    this.usageHovered = hovered
    return true
  }

  scheduleRefresh(refresh: () => void): boolean {
    if (this.pointerX === undefined || this.layoutFrame !== undefined) return false
    const run = () => {
      this.host.renderer.off(CliRenderEvents.FRAME, run)
      this.layoutFrame = undefined
      if (this.host.destroyed()) return
      refresh()
    }
    this.layoutFrame = run
    this.host.renderer.on(CliRenderEvents.FRAME, run)
    return true
  }

  release(): void {
    if (this.layoutFrame === undefined) return
    this.host.renderer.off(CliRenderEvents.FRAME, this.layoutFrame)
    this.layoutFrame = undefined
  }
}
