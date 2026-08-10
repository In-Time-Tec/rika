import { CliRenderEvents, type MouseEvent } from "@opentui/core"
import {
  mountedTranscriptRowBudget,
  transcriptOverscanRows,
} from "../../presentation/transcript/terminal-transcript-window"
import { itemPositionAtVirtualRow } from "../../presentation/transcript/transcript-virtual-index"
import { clampScrollTop, isFollowing } from "../../presentation/transcript/transcript-viewport"
import {
  maxScrollTop,
  atBottomWithin,
  type ViewportMetrics,
} from "../../presentation/transcript/transcript-viewport-metrics"
import { reduceViewport } from "../../presentation/transcript/transcript-viewport-reducer"
import { topmostVisibleAnchor } from "../../presentation/transcript/transcript-anchor-geometry"
import type { ViewportAnchor } from "../../presentation/transcript/transcript-viewport-state"
import type { ViewportEvent } from "../../presentation/transcript/transcript-viewport-protocol"
import { maxMountedTranscriptEntries } from "../rendering/opentui-render-transcript-window"
import type { Model } from "../../state/model/terminal-state"
import type { PendingTranscriptPosition, TranscriptAnchor } from "./opentui-surface-transcript-types"
import { Effect, Fiber, Schedule } from "effect"
import { SurfaceTranscriptRendering } from "./opentui-transcript-rendering"

export abstract class SurfaceTranscriptScroll extends SurfaceTranscriptRendering {
  protected abstract update(model: Model, preserveTranscriptAnchor?: boolean): void
  protected transcriptMetrics(): ViewportMetrics {
    return {
      scrollTop: this.transcriptScroll.scrollTop,
      scrollHeight: this.transcriptScroll.scrollHeight,
      viewportHeight: this.transcriptScroll.viewport.height,
    }
  }
  protected readonly atMountedTranscriptBottom = (): boolean =>
    atBottomWithin(this.transcriptMetrics(), this.transcriptOverscan())
  protected transcriptOverscan(): number {
    return Math.max(transcriptOverscanRows, this.transcriptScroll.viewport.height)
  }
  protected transcriptBandAfterRow(row: number): number {
    let low = 0
    let high = this.transcriptBandRowPrefix.length - 1
    while (low < high) {
      const middle = (low + high) >> 1
      if (this.transcriptBandRowPrefix[middle]! < row) low = middle + 1
      else high = middle
    }
    return Math.max(1, Math.min(this.transcriptBandTotal, low))
  }
  protected firstTranscriptBandWindowEnd(): number {
    const viewportRows =
      this.transcriptScroll.viewport.height > 0 ? this.transcriptScroll.viewport.height : (this.model?.height ?? 1)
    const budget = mountedTranscriptRowBudget(viewportRows)
    let low = 0
    let high = this.transcriptBandRowPrefix.length
    while (low < high) {
      const middle = (low + high) >> 1
      if ((this.transcriptBandRowPrefix[middle] ?? Number.POSITIVE_INFINITY) <= budget) low = middle + 1
      else high = middle
    }
    return Math.max(1, Math.min(this.transcriptBandTotal, low - 1))
  }
  protected readonly atTranscriptBottom = (near = false): boolean =>
    atBottomWithin(this.transcriptMetrics(), near ? 1 : 0) &&
    this.transcriptWindowEnd >= (this.model?.items.length ?? 0) &&
    this.transcriptBandEnd >= this.transcriptBandTotal
  protected dispatchTranscriptViewport(event: ViewportEvent): void {
    const previousMode = this.transcriptViewport.mode
    const decision = reduceViewport(this.transcriptViewport, event)
    this.transcriptViewport = decision.viewport
    if (previousMode !== decision.viewport.mode || event._tag === "ResetCommanded") this.scrollGeneration += 1
    for (const effect of decision.effects)
      switch (effect._tag) {
        case "ProjectState":
          this.transcriptScroll.stickyScroll = isFollowing(this.transcriptViewport.mode)
          break
        case "RequestFollowPosition":
          if (event._tag === "FollowCommanded" && this.model !== undefined) {
            this.transcriptWindowEnd = this.model.items.length
            this.transcriptBandEnd = Number.POSITIVE_INFINITY
            this.transcriptRenderInput = undefined
            this.update(this.model)
          }
          this.scheduleTranscriptPosition({ _tag: "Follow", threadId: this.model?.currentThreadId })
          break
        case "NotifyDetached":
          this.handlers.scroll?.(this.transcriptScroll.scrollTop)
          break
        case "NotifyFollowed":
          this.handlers.scrollFollow?.()
          break
        case "QueueAnchorScroll":
          this.queuePendingTranscriptScroll(effect.scrollBy)
          break
        case "ScheduleWheelSettle":
          this.scheduleWheelSettle(effect.token)
          break
        case "PageForward":
          if (!this.shiftTranscriptWindow(100, true, effect.scrollBy)) this.handleTranscriptScroll()
          break
        case "ReportSettled":
          this.handleTranscriptScroll()
          break
      }
  }
  protected scheduleWheelSettle(token: number): void {
    this.wheelTimer = this.clock.setTimeout(() => {
      this.wheelTimer = undefined
      this.dispatchTranscriptViewport({
        _tag: "WheelSettleFired",
        token,
        atTrueBottom: this.atTranscriptBottom(),
        atMountedBottom: this.atMountedTranscriptBottom(),
      })
    }, 16)
  }
  protected clampTranscriptScrollTop(scrollTop: number): number {
    return clampScrollTop(scrollTop, { ...this.transcriptMetrics(), scrollTop })
  }
  protected ensureTranscriptBandsAt(scrollTop: number): void {
    const model = this.model
    if (model === undefined || this.transcriptBandTotal === 0) return
    const viewportRows = Math.max(1, this.transcriptScroll.viewport.height)
    const desiredTop = Math.max(0, scrollTop - transcriptOverscanRows)
    const desiredBottom = Math.min(this.transcriptWindowExactRows, scrollTop + viewportRows + transcriptOverscanRows)
    const mountedTop = this.transcriptBandRowPrefix[this.transcriptMountedBandStart] ?? 0
    const mountedBottom = this.transcriptBandRowPrefix[this.transcriptBandEnd] ?? this.transcriptWindowExactRows
    if (desiredTop >= mountedTop && desiredBottom <= mountedBottom) return
    let low = 0
    let high = this.transcriptBandRowPrefix.length - 1
    while (low < high) {
      const middle = (low + high) >> 1
      if (this.transcriptBandRowPrefix[middle]! < desiredBottom) low = middle + 1
      else high = middle
    }
    const bandEnd = Math.max(1, Math.min(this.transcriptBandTotal, low))
    const previousTop = this.transcriptScroll.scrollTop
    this.transcriptBandRefreshing = true
    try {
      this.transcriptBandEnd = bandEnd
      this.transcriptBandTargetTop = desiredTop
      this.transcriptRenderInput = undefined
      this.update(model, false)
      this.scrollProgrammatic = true
      this.transcriptScroll.scrollTop = this.clampTranscriptScrollTop(previousTop)
    } finally {
      this.scrollProgrammatic = false
      this.transcriptBandTargetTop = undefined
      this.transcriptBandRefreshing = false
    }
  }
  protected applyTranscriptPosition(scrollTop: number): void {
    let target = this.clampTranscriptScrollTop(scrollTop)
    this.ensureTranscriptBandsAt(target)
    target = this.clampTranscriptScrollTop(target)
    if (target === this.transcriptScroll.scrollTop) return
    this.scrollProgrammatic = true
    this.transcriptScroll.scrollTop = target
    this.scrollProgrammatic = false
  }
  protected captureViewportAnchor(): ViewportAnchor | undefined {
    const anchor = this.captureTranscriptAnchor()
    return anchor === undefined ? undefined : { unitId: anchor.key, offset: anchor.screenY }
  }
  protected captureTranscriptAnchor(): TranscriptAnchor | undefined {
    return topmostVisibleAnchor(
      [...this.transcriptRecords.values()].map(({ key, renderable }) => ({
        key,
        screenY: renderable.screenY,
        height: renderable.height,
      })),
      {
        viewportTop: this.transcriptScroll.screenY,
        drift: this.transcriptScroll.scrollTop - this.renderedTranscriptScrollTop,
      },
    )
  }
  protected handleTranscriptScroll(): void {
    this.ensureTranscriptBandsAt(this.transcriptScroll.scrollTop)
    if (this.transcriptScroll.scrollTop <= this.transcriptOverscan() && this.shiftTranscriptWindow(-100, true)) return
    this.reportTranscriptScroll()
  }
  protected handleTranscriptWheel(event: MouseEvent): void {
    const direction = event.scroll?.direction
    if (direction !== "up" && direction !== "down") return
    this.dispatchTranscriptViewport({
      _tag: "WheelObserved",
      direction,
      delta: event.scroll?.delta ?? 1,
      atTrueBottom: this.atTranscriptBottom(),
      atMountedBottom: this.atMountedTranscriptBottom(),
      anchorPending: this.pendingTranscriptPosition?._tag === "Anchor",
      anchor: this.captureViewportAnchor(),
    })
  }
  protected cancelWheelReport(): void {
    if (this.wheelTimer !== undefined) {
      this.clock.clearTimeout(this.wheelTimer)
      this.wheelTimer = undefined
    }
    this.dispatchTranscriptViewport({ _tag: "WheelCancelled" })
  }
  protected shiftTranscriptWindow(delta: number, preserveAnchor: boolean, scrollBy = 0, nearBottom = false): boolean {
    const model = this.model
    if (model === undefined) return false
    const minimumEnd = Math.min(maxMountedTranscriptEntries, model.items.length)
    const windowEnd = Math.min(model.items.length, Math.max(minimumEnd, this.transcriptWindowEnd + delta))
    if (windowEnd === this.transcriptWindowEnd) return false
    this.transcriptWindowEnd = windowEnd
    this.transcriptBandEnd = Number.POSITIVE_INFINITY
    this.transcriptRenderInput = undefined
    this.transcriptAnchorScrollBy = scrollBy
    this.transcriptAnchorNearBottom = nearBottom
    this.update(model, preserveAnchor)
    return true
  }
  protected queuePendingTranscriptScroll(scrollBy: number, nearBottom = false): boolean {
    const pending = this.pendingTranscriptPosition
    if (pending?._tag !== "Anchor" || pending.threadId !== this.model?.currentThreadId) return false
    this.pendingTranscriptPosition = { ...pending, scrollBy: pending.scrollBy + scrollBy, nearBottom }
    this.renderer.requestRender()
    return true
  }
  protected readonly reportTranscriptScroll = (nearBottom = false) => {
    if (this.scrollProgrammatic || this.destroyed) return
    this.syncTranscriptScrollbar()
    if (this.atTranscriptBottom(nearBottom)) this.dispatchTranscriptViewport({ _tag: "BottomSettled" })
    else this.handlers.scroll?.(this.transcriptScroll.scrollTop)
  }
  protected syncTranscriptScrollbar(): void {
    if (this.destroyed) return
    const viewportHeight = this.transcriptScroll.viewport.height
    const virtual = this.transcriptVirtualMetrics()
    const scrollHeight = virtual.scrollHeight
    const rowsAbove = virtual.rowsAbove
    const scrollTop = rowsAbove + this.transcriptScroll.scrollTop
    const overflowing = viewportHeight > 0 && scrollHeight > Math.max(viewportHeight, this.transcriptViewportRows)
    this.scrollbarSyncing = true
    try {
      this.transcriptScrollbar.scrollSize = scrollHeight
      this.transcriptScrollbar.viewportSize = Math.max(1, viewportHeight)
      this.transcriptScrollbar.scrollPosition = scrollTop
    } finally {
      this.scrollbarSyncing = false
    }
    if (this.transcriptScrollbar.visible !== overflowing) this.transcriptScrollbar.visible = overflowing
  }
  protected applyVirtualScrollbarPosition(position: number): void {
    const model = this.model
    if (model === undefined) return
    const windowMax = Math.max(0, this.transcriptScroll.scrollHeight - this.transcriptScroll.viewport.height)
    const rowsAbove = this.transcriptVirtualMetrics().rowsAbove
    if (position >= rowsAbove && position - rowsAbove <= windowMax) {
      this.applyTranscriptPosition(Math.max(0, Math.min(position - rowsAbove, windowMax)))
      return
    }
    const windowStartItem = Math.max(0, this.transcriptWindowEnd - maxMountedTranscriptEntries)
    const targetItem = itemPositionAtVirtualRow(this.virtualIndex(model), position)
    const center = windowStartItem + Math.floor(maxMountedTranscriptEntries / 2)
    const delta = targetItem - center
    if (delta !== 0 && this.shiftTranscriptWindow(delta, false)) {
      this.pendingTranscriptPosition = undefined
      this.syncTranscriptScrollbar()
    }
    const afterRowsAbove = this.transcriptVirtualMetrics().rowsAbove
    const afterMax = Math.max(0, this.transcriptScroll.scrollHeight - this.transcriptScroll.viewport.height)
    this.applyTranscriptPosition(Math.max(0, Math.min(position - afterRowsAbove, afterMax)))
  }
  protected queueTranscriptScroll(action: () => void): void {
    const generation = this.scrollGeneration
    this.defer(() => {
      if (this.destroyed || generation !== this.scrollGeneration) return
      action()
    })
  }
  protected scheduleTranscriptPosition(position: Omit<PendingTranscriptPosition, "token">): void {
    const token = this.nextTranscriptPositionToken
    this.nextTranscriptPositionToken += 1
    this.pendingTranscriptPosition = { ...position, token } as PendingTranscriptPosition
    if (this.transcriptPositionFrame !== undefined)
      this.renderer.off(CliRenderEvents.FRAME, this.transcriptPositionFrame)
    const apply = () => {
      this.renderer.off(CliRenderEvents.FRAME, apply)
      if (this.transcriptPositionFrame === apply) this.transcriptPositionFrame = undefined
      const current = this.pendingTranscriptPosition
      if (current === undefined || current.token !== token || this.destroyed) return
      this.pendingTranscriptPosition = undefined
      if (current.threadId !== this.model?.currentThreadId) return
      if (current._tag === "Follow" && !isFollowing(this.transcriptViewport.mode)) return
      if (current._tag === "Anchor") {
        if (isFollowing(this.transcriptViewport.mode)) return
        const anchored = current.anchor === undefined ? undefined : this.transcriptRecords.get(current.anchor.key)
        const anchorScreenY = current.anchor?.screenY
        const offset =
          anchored === undefined || anchorScreenY === undefined ? 0 : anchored.renderable.screenY - anchorScreenY
        this.applyTranscriptPosition(this.transcriptScroll.scrollTop + offset + current.scrollBy)
        if (current.scrollBy === 0) this.handlers.scrollGeometry?.(this.transcriptScroll.scrollTop)
        else this.reportTranscriptScroll(current.nearBottom)
      } else this.applyTranscriptPosition(maxScrollTop(this.transcriptMetrics()))
      this.syncTranscriptScrollbar()
      this.renderer.requestRender()
    }
    this.transcriptPositionFrame = apply
    this.renderer.once(CliRenderEvents.FRAME, apply)
    this.renderer.requestRender()
  }
  protected cancelTimer(timer: Fiber.Fiber<void> | undefined): void {
    timer?.interruptUnsafe()
  }
  protected defer(action: () => void): void {
    Effect.runFork(Effect.yieldNow.pipe(Effect.andThen(Effect.sync(action))))
  }
  protected delayed(duration: number, action: () => void): Fiber.Fiber<void> {
    return Effect.runFork(Effect.sleep(duration).pipe(Effect.andThen(Effect.sync(action))))
  }
  protected repeated(duration: number, action: () => void): Fiber.Fiber<void> {
    return Effect.runFork(
      Effect.sleep(duration).pipe(
        Effect.andThen(Effect.sync(action)),
        Effect.repeat(Schedule.spaced(duration)),
        Effect.asVoid,
      ),
    )
  }
}
