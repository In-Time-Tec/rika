import {
  CliRenderEvents,
  ScrollBarRenderable,
  ScrollBoxRenderable,
  type CliRenderer,
  type MouseEvent,
} from "@opentui/core"
import { Effect as EffectRuntime } from "effect"
import { topmostVisibleAnchor } from "../../../presentation/transcript/viewport/anchor-geometry"
import {
  mountedTranscriptRowBudget,
  transcriptOverscanRows,
} from "../../../presentation/transcript/window"
import { clampScrollTop } from "../../../presentation/transcript/viewport/model"
import { atBottomWithin, type ViewportMetrics } from "../../../presentation/transcript/viewport/metrics"
import type { ViewportAnchor } from "../../../presentation/transcript/viewport/state"
import type {
  TranscriptAnchor,
  TranscriptAnchorTarget,
  TranscriptRenderableRecord,
} from "./types"

interface TranscriptAnchorRestoration {
  readonly scrollTop: number
  readonly target: TranscriptAnchorTarget | undefined
}

export class TranscriptPaneFrame {
  private pending = false

  constructor(
    private readonly renderer: CliRenderer,
    private readonly settle: () => void,
  ) {
    if (renderer.setFrameCallback === undefined) renderer.on(CliRenderEvents.FRAME, this.prepareAfterFrame)
    else renderer.setFrameCallback(this.prepare)
  }

  readonly prepare: Parameters<NonNullable<CliRenderer["setFrameCallback"]>>[0] = (_deltaTime) => {
    this.pending = false
    this.settle()
    return EffectRuntime.runPromise(EffectRuntime.void)
  }

  request(): void {
    this.pending = true
    this.renderer.requestRender()
  }

  settleNow(): void {
    if (!this.pending) this.settle()
  }

  destroy(): void {
    if (this.renderer.removeFrameCallback === undefined)
      this.renderer.off(CliRenderEvents.FRAME, this.prepareAfterFrame)
    else this.renderer.removeFrameCallback(this.prepare)
  }

  private readonly prepareAfterFrame = () => {
    void this.prepare(0)
  }
}

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
    this.slider.onMouseScroll = handler
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

  synchronize(viewportRows: number, contentRows: number | undefined): void {
    const viewportHeight = this.scroll.viewport.height > 0 ? this.scroll.viewport.height : viewportRows
    if (viewportHeight <= 0) return
    const scrollHeight =
      contentRows === undefined
        ? Math.max(viewportHeight, this.scroll.content.height)
        : Math.max(viewportRows, contentRows)
    this.scroll.verticalScrollBar.scrollSize = Math.max(scrollHeight, viewportHeight)
    this.scroll.verticalScrollBar.viewportSize = viewportHeight
  }

  atMountedBottom(): boolean {
    return atBottomWithin(this.metrics(), this.overscan())
  }

  clampScrollTop(scrollTop: number): number {
    return clampScrollTop(scrollTop, { ...this.metrics(), scrollTop })
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
    rowByKey: ReadonlyMap<string, number>,
  ): TranscriptAnchor | undefined {
    const drift = this.scroll.scrollTop - renderedScrollTop
    const candidates = [...records.values()].flatMap(({ key, renderable }) => {
      const row = rowByKey.get(key)
      return row === undefined
        ? []
        : [
            {
              key,
              screenY: renderable.screenY,
              height: renderable.height,
              row,
            },
          ]
    })
    const anchor = topmostVisibleAnchor(candidates, { viewportTop: this.scroll.screenY, drift })
    if (anchor === undefined) return undefined
    const fallbacks = candidates
      .filter(({ key, height }) => key !== anchor.key && height > 0)
      .map(({ key, screenY, row }) => ({ key, screenY: screenY + drift, row, scrollTop: renderedScrollTop }))
      .toSorted(
        (left, right) =>
          Math.abs(left.screenY - anchor.screenY) - Math.abs(right.screenY - anchor.screenY) ||
          left.screenY - right.screenY,
      )
    return { ...anchor, row: rowByKey.get(anchor.key)!, scrollTop: renderedScrollTop, fallbacks }
  }

  readingAnchor(
    records: ReadonlyMap<string, TranscriptRenderableRecord>,
    renderedScrollTop: number,
    rowByKey: ReadonlyMap<string, number>,
  ): ViewportAnchor | undefined {
    const anchor = this.captureAnchor(records, renderedScrollTop, rowByKey)
    if (anchor !== undefined) return { unitId: anchor.key, offset: anchor.screenY }
    const first = [...records.values()][0]
    return first === undefined ? undefined : { unitId: first.key, offset: 0 }
  }

  restoreAnchor(
    anchor: TranscriptAnchor | undefined,
    records: ReadonlyMap<string, TranscriptRenderableRecord>,
    rowByKey: ReadonlyMap<string, number>,
  ): TranscriptAnchorRestoration {
    const target =
      anchor === undefined
        ? undefined
        : [anchor, ...anchor.fallbacks].find(({ key }) => records.has(key) && rowByKey.has(key))
    const targetRow = target === undefined ? undefined : rowByKey.get(target.key)
    return {
      target,
      scrollTop:
        target === undefined || targetRow === undefined
          ? this.scroll.scrollTop
          : target.scrollTop + targetRow - target.row,
    }
  }
}
