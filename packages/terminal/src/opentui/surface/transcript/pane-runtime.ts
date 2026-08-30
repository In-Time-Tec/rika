import type { MouseEvent } from "@opentui/core"
import { Effect } from "effect"
import { transcriptOverscanRows } from "../../../presentation/transcript/window"
import { isFollowing } from "../../../presentation/transcript/viewport/model"
import { atBottomWithin, maxScrollTop } from "../../../presentation/transcript/viewport/metrics"
import type { ViewportEvent } from "../../../presentation/transcript/viewport/protocol"
import { reduceViewport } from "../../../presentation/transcript/viewport/reducer"
import type { ViewportAnchor } from "../../../presentation/transcript/viewport/state"
import { spacing } from "../../../presentation/terminal/theme"
import { maxMountedTranscriptEntries } from "../../rendering/transcript/window"
import type { PendingTranscriptPosition } from "./types"
import { TranscriptPaneRuntimeBase } from "./pane-runtime-base"

export type { TranscriptPaneDiagnostics, TranscriptPaneHandlers } from "./pane-runtime-base"

const runFork = Effect.runFork

export abstract class TranscriptPaneRuntime extends TranscriptPaneRuntimeBase {
  pageUp(): void {
    this.cancelWheelReport()
    this.dispatchViewport({ _tag: "DetachCommanded", anchor: this.readingAnchor() })
    const amount = Math.max(1, this.scroll.viewport.height - 1)
    if (this.queuePendingScroll(-amount)) return
    if (this.scroll.scrollTop <= 1 && this.shiftWindow(-100, true, -amount)) return
    this.applyPosition(this.scroll.scrollTop - amount)
    if (this.scroll.scrollTop <= 1) {
      this.syncScrollbar()
      this.handlers.scroll?.(0)
    } else this.reportScroll()
  }

  pageDown(): void {
    this.cancelWheelReport()
    const amount = Math.max(1, this.scroll.viewport.height - 1)
    if (this.queuePendingScroll(amount, true)) return
    if (this.geometry.atMountedBottom() && this.shiftWindow(100, true, amount, true)) return
    this.applyPosition(this.scroll.scrollTop + amount)
    this.reportScroll(true)
  }

  home(): void {
    this.cancelWheelReport()
    this.dispatchViewport({ _tag: "DetachCommanded", anchor: this.readingAnchor() })
    const model = this.model
    if (model === undefined) return
    const minimumEnd = Math.min(maxMountedTranscriptEntries, model.items.length)
    if (this.windowEnd !== minimumEnd) {
      this.windowEnd = minimumEnd
      this.bandEnd = Number.POSITIVE_INFINITY
      this.renderInput = undefined
      this.update(model, false)
    }
    const firstBandEnd = this.geometry.firstBandWindowEnd(this.bandRowPrefix, this.bandTotal, this.model?.height ?? 1)
    if (this.bandEnd !== firstBandEnd || this.mountedBandStart > 0) {
      this.bandEnd = firstBandEnd
      this.renderInput = undefined
      this.update(model, false)
      this.pendingPosition = undefined
    }
    this.applyPosition(0)
    this.syncScrollbar()
    this.reportScroll()
  }

  end(): void {
    this.cancelWheelReport()
    this.dispatchViewport({ _tag: "FollowCommanded" })
  }

  captureVisibleAnchor(): ViewportAnchor | undefined {
    const anchor = this.geometry.captureAnchor(this.records, this.renderedScrollTop, this.rowByKey)
    return anchor === undefined ? undefined : { unitId: anchor.key, offset: anchor.screenY }
  }

  dispatch(event: ViewportEvent): void {
    this.dispatchViewport(event)
  }

  synchronizeScrollbar(): void {
    this.syncScrollbar()
  }

  protected handlePositionChanged(): void {
    if (this.bandRefreshing) return
    if (!this.scrollProgrammatic) {
      this.manualScrollPosition = !this.atBottom()
      if (this.manualScrollPosition && isFollowing(this.viewport.mode) && this.model?.scrollFollow === false)
        this.dispatchViewport({ _tag: "DetachCommanded", anchor: this.readingAnchor() })
    }
    this.ensureBandsAt(this.scroll.scrollTop)
    this.renderer.requestRender()
  }

  protected handleScrollbarChanged(position: number): void {
    if (this.scrollbarSyncing || this.destroyed) return
    this.cancelWheelReport()
    if (isFollowing(this.viewport.mode))
      this.dispatchViewport({ _tag: "DetachCommanded", anchor: this.readingAnchor() })
    this.applyVirtualScrollbarPosition(position)
    this.queueScroll(() => this.reportScroll())
  }

  private atBottom(near = false): boolean {
    return (
      atBottomWithin(this.geometry.metrics(), near ? 1 : 0) &&
      this.windowEnd >= (this.model?.items.length ?? 0) &&
      this.bandEnd >= this.bandTotal
    )
  }

  protected dispatchViewport(event: ViewportEvent): void {
    const previousMode = this.viewport.mode
    const decision = reduceViewport(this.viewport, event)
    this.viewport = decision.viewport
    if (previousMode !== decision.viewport.mode || event._tag === "ResetCommanded") this.scrollGeneration += 1
    for (const effect of decision.effects) this.applyViewportEffect(event, effect)
  }

  private applyViewportEffect(
    event: ViewportEvent,
    effect: ReturnType<typeof reduceViewport>["effects"][number],
  ): void {
    switch (effect._tag) {
      case "RequestFollowPosition":
        if (event._tag === "FollowCommanded" && this.model !== undefined) {
          this.windowEnd = this.model.items.length
          this.bandEnd = Number.POSITIVE_INFINITY
          this.renderInput = undefined
          this.update(this.model)
        }
        this.schedulePosition({ _tag: "Follow", threadId: this.model?.currentThreadId })
        break
      case "NotifyDetached":
        this.handlers.scroll?.(this.scroll.scrollTop)
        break
      case "NotifyFollowed":
        this.handlers.scrollFollow?.()
        break
      case "QueueAnchorScroll":
        this.queuePendingScroll(effect.scrollBy)
        break
      case "ScheduleWheelSettle":
        this.scheduleWheelSettle(effect.token)
        break
      case "PageForward":
        if (!this.shiftWindow(100, true, effect.scrollBy)) this.handleScroll()
        break
      case "ReportSettled":
        this.handleScroll()
        break
    }
  }

  private scheduleWheelSettle(token: number): void {
    this.wheelTimer = this.options.clock.setTimeout(() => {
      this.wheelTimer = undefined
      this.dispatchViewport({
        _tag: "WheelSettleFired",
        token,
        atTrueBottom: this.atBottom(),
        atMountedBottom: this.geometry.atMountedBottom(),
      })
    }, 16)
  }

  private ensureBandsAt(scrollTop: number): void {
    const model = this.model
    if (model === undefined || this.bandTotal === 0) return
    const viewportRows = Math.max(1, this.scroll.viewport.height)
    const desiredTop = Math.max(0, scrollTop - transcriptOverscanRows)
    const desiredBottom = Math.min(this.windowExactRows, scrollTop + viewportRows + transcriptOverscanRows)
    const mountedTop = this.bandRowPrefix[this.mountedBandStart] ?? 0
    const mountedBottom = this.bandRowPrefix[this.bandEnd] ?? this.windowExactRows
    if (desiredTop >= mountedTop && desiredBottom <= mountedBottom) return
    let low = 0
    let high = this.bandRowPrefix.length - 1
    while (low < high) {
      const middle = (low + high) >> 1
      if (this.bandRowPrefix[middle]! < desiredBottom) low = middle + 1
      else high = middle
    }
    const bandEnd = Math.max(1, Math.min(this.bandTotal, low))
    const previousTop = this.scroll.scrollTop
    this.bandRefreshing = true
    try {
      this.bandEnd = bandEnd
      this.bandTargetTop = desiredTop
      this.renderInput = undefined
      this.update(model, false)
      this.scrollProgrammatic = true
      this.scroll.scrollTop = this.geometry.clampScrollTop(previousTop)
    } finally {
      this.scrollProgrammatic = false
      this.bandTargetTop = undefined
      this.bandRefreshing = false
    }
  }

  private applyPosition(scrollTop: number): void {
    this.synchronizeGeometry()
    let target = this.geometry.clampScrollTop(scrollTop)
    this.ensureBandsAt(target)
    target = this.geometry.clampScrollTop(target)
    if (target === this.scroll.scrollTop) return
    this.scrollProgrammatic = true
    this.scroll.scrollTop = target
    this.scrollProgrammatic = false
  }

  private readingAnchor(): ViewportAnchor | undefined {
    return this.geometry.readingAnchor(this.records, this.renderedScrollTop, this.rowByKey)
  }

  protected handleScroll(): void {
    this.ensureBandsAt(this.scroll.scrollTop)
    if (this.scroll.scrollTop <= this.geometry.overscan() && this.shiftWindow(-100, true)) return
    this.reportScroll()
  }

  protected handleWheel(event: MouseEvent): void {
    const direction = event.scroll?.direction
    if (direction !== "up" && direction !== "down") return
    event.stopPropagation()
    if (this.model?.contextDetailsOpen === true) return
    const delta = Math.max(1, event.scroll?.delta ?? 1)
    this.dispatchViewport({
      _tag: "WheelObserved",
      direction,
      delta,
      atTrueBottom: this.atBottom(),
      atMountedBottom: this.geometry.atMountedBottom(),
      anchorPending: this.pendingPosition?._tag === "Anchor",
      anchor: this.readingAnchor(),
    })
  }

  protected cancelWheelReport(): void {
    if (this.wheelTimer !== undefined) {
      this.options.clock.clearTimeout(this.wheelTimer)
      this.wheelTimer = undefined
    }
    this.dispatchViewport({ _tag: "WheelCancelled" })
  }

  private shiftWindow(delta: number, preserveAnchor: boolean, scrollBy = 0, nearBottom = false): boolean {
    const model = this.model
    if (model === undefined) return false
    const minimumEnd = Math.min(maxMountedTranscriptEntries, model.items.length)
    const windowEnd = Math.min(model.items.length, Math.max(minimumEnd, this.windowEnd + delta))
    if (windowEnd === this.windowEnd) return false
    this.windowEnd = windowEnd
    this.bandEnd = Number.POSITIVE_INFINITY
    this.renderInput = undefined
    this.anchorScrollBy = scrollBy
    this.anchorNearBottom = nearBottom
    this.update(model, preserveAnchor)
    return true
  }

  private queuePendingScroll(scrollBy: number, nearBottom = false): boolean {
    const pending = this.pendingPosition
    if (pending?._tag !== "Anchor" || pending.threadId !== this.model?.currentThreadId) return false
    this.pendingPosition = { ...pending, scrollBy: pending.scrollBy + scrollBy, nearBottom }
    this.renderer.requestRender()
    return true
  }

  private reportScroll(nearBottom = false): void {
    if (this.scrollProgrammatic || this.destroyed) return
    this.syncScrollbar()
    if (this.atBottom(nearBottom)) this.dispatchViewport({ _tag: "BottomSettled" })
    else this.handlers.scroll?.(this.scroll.scrollTop)
  }

  private syncScrollbar(): void {
    if (this.destroyed) return
    this.synchronizeGeometry()
    const viewportHeight = this.scroll.viewport.height > 0 ? this.scroll.viewport.height : this.viewportRows
    const virtual = this.virtualMetrics()
    const scrollHeight = virtual.scrollHeight
    const scrollTop = virtual.rowsAbove + this.scroll.scrollTop
    this.scrollbarSyncing = true
    try {
      this.scrollbar.scrollSize = scrollHeight
      this.scrollbar.viewportSize = Math.max(1, viewportHeight)
      this.scrollbar.scrollPosition = scrollTop
    } finally {
      this.scrollbarSyncing = false
    }
  }

  protected projectScrollbarVisibility(): void {
    const viewportHeight = this.scroll.viewport.height > 0 ? this.scroll.viewport.height : this.viewportRows
    this.scrollbar.visible =
      this.virtualMetrics(Math.max(viewportHeight, this.windowExactRows + spacing.transcript)).scrollHeight >
      viewportHeight
  }

  private applyVirtualScrollbarPosition(position: number): void {
    const model = this.model
    if (model === undefined) return
    const virtualMax = Math.max(0, this.virtualMetrics().scrollHeight - this.scroll.viewport.height)
    const atVirtualEnd = position >= virtualMax
    const windowMax = Math.max(0, this.scroll.scrollHeight - this.scroll.viewport.height)
    const rowsAbove = this.virtualMetrics().rowsAbove
    if (position >= rowsAbove && position - rowsAbove <= windowMax) {
      this.applyPosition(Math.max(0, Math.min(position - rowsAbove, windowMax)))
      return
    }
    const windowStartItem = Math.max(0, this.windowEnd - maxMountedTranscriptEntries)
    const targetItem = this.virtualDocument.itemAtRow(model, position)
    const center = windowStartItem + Math.floor(maxMountedTranscriptEntries / 2)
    const delta = targetItem - center
    if (delta !== 0 && this.shiftWindow(delta, false)) {
      this.pendingPosition = undefined
      this.syncScrollbar()
    }
    const afterRowsAbove = this.virtualMetrics().rowsAbove
    const afterMax = Math.max(0, this.scroll.scrollHeight - this.scroll.viewport.height)
    this.applyPosition(atVirtualEnd ? afterMax : Math.max(0, Math.min(position - afterRowsAbove, afterMax)))
  }

  private queueScroll(action: () => void): void {
    const generation = this.scrollGeneration
    this.defer(() => {
      if (this.destroyed || generation !== this.scrollGeneration) return
      action()
    })
  }

  protected schedulePosition(position: PendingTranscriptPosition): void {
    this.pendingPosition = position
    this.frame.request()
  }

  protected settleFrame(): void {
    if (this.destroyed) return
    this.synchronizeGeometry()
    const current = this.pendingPosition
    if (current !== undefined) this.settlePosition(current)
    if (
      !this.manualScrollPosition &&
      (this.staticContent || (this.model !== undefined && isFollowing(this.viewport.mode))) &&
      !this.atBottom()
    ) {
      this.applyPosition(maxScrollTop(this.geometry.metrics()))
    }
    this.syncScrollbar()
  }

  private settlePosition(current: PendingTranscriptPosition): void {
    this.pendingPosition = undefined
    if (current.threadId !== this.model?.currentThreadId) return
    if (current._tag === "Follow" && isFollowing(this.viewport.mode)) {
      this.manualScrollPosition = false
      this.applyPosition(maxScrollTop(this.geometry.metrics()))
      return
    }
    if (current._tag !== "Anchor" || isFollowing(this.viewport.mode)) return
    const restored = this.geometry.restoreAnchor(current.anchor, this.records, this.rowByKey)
    const target = restored.target
    this.applyPosition(restored.scrollTop + current.scrollBy)
    if (target !== undefined && target.key !== current.anchor?.key)
      this.dispatchViewport({ _tag: "AnchorRebased", anchor: { unitId: target.key, offset: target.screenY } })
    if (current.scrollBy === 0) this.handlers.scrollGeometry?.(this.scroll.scrollTop)
    else this.reportScroll(current.nearBottom)
    if (current.scrollBy === 0 && maxScrollTop(this.geometry.metrics()) === 0)
      this.dispatchViewport({ _tag: "BottomSettled" })
  }

  protected synchronizeGeometry(): void {
    this.geometry.synchronize(
      this.viewportRows,
      this.model === undefined ? undefined : this.windowExactRows + spacing.transcript,
    )
  }

  protected virtualMetrics(physicalScrollHeight = this.scroll.scrollHeight): {
    readonly scrollHeight: number
    readonly rowsAbove: number
  } {
    return this.virtualDocument.metrics({
      model: this.model,
      windowEnd: this.windowEnd,
      bandRowsBefore: this.bandRowsBefore,
      bandRowsAfter: this.bandRowsAfter,
      physicalScrollHeight,
    })
  }

  private defer(action: () => void): void {
    runFork(Effect.yieldNow.pipe(Effect.andThen(Effect.sync(action))))
  }
}
