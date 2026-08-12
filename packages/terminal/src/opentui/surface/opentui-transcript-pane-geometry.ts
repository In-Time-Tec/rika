import { ScrollBarRenderable, ScrollBoxRenderable, type MouseEvent } from "@opentui/core"
import { topmostVisibleAnchor } from "../../presentation/transcript/transcript-anchor-geometry"
import {
  mountedTranscriptRowBudget,
  transcriptOverscanRows,
} from "../../presentation/transcript/terminal-transcript-window"
import { atBottomWithin, type ViewportMetrics } from "../../presentation/transcript/transcript-viewport-metrics"
import type { ViewportAnchor } from "../../presentation/transcript/transcript-viewport-state"
import type { TranscriptAnchor, TranscriptRenderableRecord } from "./opentui-surface-transcript-types"

export class TranscriptScrollBoxRenderable extends ScrollBoxRenderable {
  onPositionChanged: (() => void) | undefined
  override scrollTo(position: number | { readonly x: number; readonly y: number }): void {
    super.scrollTo(position)
    this.onPositionChanged?.()
  }
  observeWheel(event: MouseEvent): void {
    super.onMouseEvent(event)
  }
}

export class TranscriptScrollBarRenderable extends ScrollBarRenderable {
  setWheelHandler(handler: ((event: MouseEvent) => void) | undefined): void {
    this.onMouseScroll = handler
    const slider = Reflect.get(this, "slider") as ScrollBarRenderable["slider"] | undefined
    if (slider !== undefined) slider.onMouseScroll = handler
  }
}

export class TranscriptPaneGeometry {
  constructor(private readonly scroll: ScrollBoxRenderable) {}

  metrics(): ViewportMetrics {
    return {
      scrollTop: this.scroll.scrollTop,
      scrollHeight: this.scroll.scrollHeight,
      viewportHeight: this.scroll.viewport.height,
    }
  }

  synchronize(): void {
    const viewportHeight = this.scroll.viewport.height
    const contentHeight = this.scroll.content.height
    if (viewportHeight <= 0 || contentHeight <= 0) return
    this.scroll.verticalScrollBar.scrollSize = contentHeight
    this.scroll.verticalScrollBar.viewportSize = viewportHeight
  }

  atMountedBottom(): boolean {
    return atBottomWithin(this.metrics(), this.overscan())
  }

  overscan(): number {
    return Math.max(transcriptOverscanRows, this.scroll.viewport.height)
  }

  firstBandWindowEnd(rowPrefix: ReadonlyArray<number>, bandTotal: number, fallbackRows: number): number {
    const viewportRows = this.scroll.viewport.height > 0 ? this.scroll.viewport.height : fallbackRows
    const budget = mountedTranscriptRowBudget(viewportRows)
    let low = 0
    let high = rowPrefix.length
    while (low < high) {
      const middle = (low + high) >> 1
      if ((rowPrefix[middle] ?? Number.POSITIVE_INFINITY) <= budget) low = middle + 1
      else high = middle
    }
    return Math.max(1, Math.min(bandTotal, low - 1))
  }

  captureAnchor(
    records: ReadonlyMap<string, TranscriptRenderableRecord>,
    renderedScrollTop: number,
  ): TranscriptAnchor | undefined {
    return topmostVisibleAnchor(
      [...records.values()].map(({ key, renderable }) => ({
        key,
        screenY: renderable.screenY,
        height: renderable.height,
      })),
      {
        viewportTop: this.scroll.screenY,
        drift: this.scroll.scrollTop - renderedScrollTop,
      },
    )
  }

  readingAnchor(
    records: ReadonlyMap<string, TranscriptRenderableRecord>,
    renderedScrollTop: number,
  ): ViewportAnchor | undefined {
    const anchor = this.captureAnchor(records, renderedScrollTop)
    if (anchor !== undefined) return { unitId: anchor.key, offset: anchor.screenY }
    const first = records.values().next().value as TranscriptRenderableRecord | undefined
    return first === undefined ? undefined : { unitId: first.key, offset: 0 }
  }
}
