import {
  BoxRenderable,
  CliRenderEvents,
  TextRenderable,
  type CliRenderer,
  type Clock as OpenTuiClock,
  type MouseEvent,
  type TimerHandle,
} from "@opentui/core"
import { Effect } from "effect"
import { transcriptOverscanRows } from "../../presentation/transcript/terminal-transcript-window"
import { clampScrollTop, isFollowing } from "../../presentation/transcript/transcript-viewport"
import { atBottomWithin, maxScrollTop } from "../../presentation/transcript/transcript-viewport-metrics"
import type { ViewportEvent } from "../../presentation/transcript/transcript-viewport-protocol"
import { reduceViewport } from "../../presentation/transcript/transcript-viewport-reducer"
import {
  initialViewport,
  type TranscriptViewport,
  type ViewportAnchor,
} from "../../presentation/transcript/transcript-viewport-state"
import { colors, spacing } from "../../presentation/terminal/terminal-theme"
import type { Model } from "../../state/model/terminal-state"
import { maxMountedTranscriptEntries } from "../rendering/opentui-render-transcript-window"
import { toOpenColor } from "../rendering/terminal-text-adapter"
import { prependedTranscriptItems } from "./opentui-lifecycle-transcript"
import { cutoutBackground } from "./opentui-surface-renderables"
import type {
  PendingTranscriptPosition,
  TranscriptRenderableRecord,
  TranscriptRenderInput,
} from "./opentui-surface-transcript-types"
import {
  TranscriptPaneGeometry,
  TranscriptScrollBarRenderable,
  TranscriptScrollBoxRenderable,
} from "./opentui-transcript-pane-geometry"
import {
  projectTranscriptRows,
  updateTranscriptSpinners,
  type TranscriptPathTarget,
  type TranscriptRowsCache,
} from "./opentui-transcript-renderables"
import { TranscriptVirtualDocument } from "./opentui-transcript-virtual-document"

export interface TranscriptPaneHandlers {
  readonly scroll?: (offset: number) => void
  readonly scrollGeometry?: (offset: number) => void
  readonly scrollFollow?: () => void
  readonly clickToggle?: (unit: string) => void
  readonly openPath?: (target: TranscriptPathTarget) => void
  readonly clearWelcome?: () => void
}

export interface TranscriptPaneDiagnostics {
  readonly rows: ReadonlyArray<TextRenderable>
  readonly keys: ReadonlyArray<string>
  readonly windowEnd: number
  readonly rowTotal: number
  readonly mountedPhysicalRows: number
  readonly spacerRowsBefore: number
  readonly spacerRowsAfter: number
  readonly following: boolean
  readonly virtualScrollTop: number
  readonly virtualScrollHeight: number
}

export class TranscriptPane {
  readonly scroll: TranscriptScrollBoxRenderable
  readonly scrollbar: TranscriptScrollBarRenderable
  readonly topSpacer: BoxRenderable
  readonly bottomSpacer: BoxRenderable
  private readonly handlers: TranscriptPaneHandlers
  private model: Model | undefined
  private children: Array<TextRenderable> = []
  private records = new Map<string, TranscriptRenderableRecord>()
  private unitCache: TranscriptRowsCache = new Map()
  private renderInput: TranscriptRenderInput | undefined
  private scrollProgrammatic = false
  private wheelTimer: TimerHandle | undefined
  private viewport: TranscriptViewport = initialViewport
  private viewportRows = 0
  private renderedScrollTop = 0
  private windowEnd = 0
  private rowTotal = 0
  private bandEnd = Number.POSITIVE_INFINITY
  private bandTotal = 0
  private mountedBandStart = 0
  private mountedRows = 0
  private bandRowsBefore = 0
  private bandRowsAfter = 0
  private windowExactRows = 0
  private bandRowPrefix: ReadonlyArray<number> = [0]
  private mountAnchorKey: string | undefined
  private bandRefreshing = false
  private bandTargetTop: number | undefined
  private readonly virtualDocument = new TranscriptVirtualDocument()
  private windowThread: string | undefined
  private positionFrame: (() => void) | undefined
  private scrollbarSyncPending = false
  private anchorScrollBy = 0
  private anchorNearBottom = false
  private pendingPosition: PendingTranscriptPosition | undefined
  private nextPositionToken = 0
  private scrollbarSyncing = false
  private scrollGeneration = 0
  private manualScrollPosition = false
  private spinnerGlyph = ""
  private staticContent = false
  private destroyed = false
  private readonly geometry: TranscriptPaneGeometry
  private readonly recordRenderedScroll = () => {
    this.geometry.synchronize()
    this.renderedScrollTop = this.scroll.scrollTop
    if (
      !this.destroyed &&
      !this.manualScrollPosition &&
      this.pendingPosition === undefined &&
      (this.staticContent || (this.model !== undefined && isFollowing(this.viewport.mode))) &&
      !this.atBottom()
    )
      this.schedulePosition({ _tag: "Follow", threadId: this.model?.currentThreadId })
  }

  constructor(
    private readonly renderer: CliRenderer,
    private readonly options: { readonly clock: OpenTuiClock; readonly handlers?: TranscriptPaneHandlers },
  ) {
    this.handlers = options.handlers ?? {}
    const background = cutoutBackground(renderer)
    this.scroll = new TranscriptScrollBoxRenderable(renderer, {
      flexGrow: 1,
      scrollY: true,
      stickyScroll: true,
      stickyStart: "bottom",
      viewportCulling: true,
      verticalScrollbarOptions: { visible: false },
      rootOptions: { backgroundColor: background },
      wrapperOptions: { backgroundColor: background },
      viewportOptions: { backgroundColor: background },
      contentOptions: {
        flexDirection: "column",
        justifyContent: "flex-end",
        backgroundColor: background,
        paddingTop: spacing.transcript,
        paddingBottom: 0,
        paddingLeft: spacing.transcript,
        paddingRight: spacing.transcript + 1,
      },
      onMouseScroll: (event) => this.handleWheel(event),
    })
    this.geometry = new TranscriptPaneGeometry(this.scroll)
    const viewportSizeChange = this.scroll.viewport.onSizeChange
    this.scroll.viewport.onSizeChange = () => {
      viewportSizeChange?.call(this.scroll.viewport)
      this.handleScrollBoxSizeChanged()
    }
    const contentSizeChange = this.scroll.content.onSizeChange
    this.scroll.content.onSizeChange = () => {
      contentSizeChange?.call(this.scroll.content)
      this.handleScrollBoxSizeChanged()
    }
    this.scroll.focusable = false
    this.scroll.verticalScrollBar.focusable = false
    this.scroll.verticalScrollBar.visible = false
    this.scroll.onPositionChanged = () => {
      if (this.bandRefreshing) return
      if (!this.scrollProgrammatic) this.manualScrollPosition = !this.atBottom()
      this.ensureBandsAt(this.scroll.scrollTop)
      this.renderer.requestRender()
    }
    this.topSpacer = new BoxRenderable(renderer, { height: 0, flexShrink: 0, visible: false })
    this.bottomSpacer = new BoxRenderable(renderer, { height: 0, flexShrink: 0, visible: false })
    this.scrollbar = new TranscriptScrollBarRenderable(renderer, {
      orientation: "vertical",
      showArrows: false,
      position: "absolute",
      top: 0,
      bottom: 0,
      right: 0,
      width: 1,
      zIndex: 1,
      visible: false,
      trackOptions: { foregroundColor: toOpenColor(colors.text), backgroundColor: toOpenColor(colors.muted) },
      onChange: (position) => {
        if (this.scrollbarSyncing || this.destroyed) return
        this.cancelWheelReport()
        if (isFollowing(this.viewport.mode))
          this.dispatchViewport({ _tag: "DetachCommanded", anchor: this.readingAnchor() })
        this.applyVirtualScrollbarPosition(position)
        this.queueScroll(() => this.reportScroll())
      },
    })
    this.scrollbar.focusable = false
    this.scrollbar.setWheelHandler((event) => {
      this.scroll.observeWheel(event)
      this.handleWheel(event)
    })
    renderer.on(CliRenderEvents.FRAME, this.recordRenderedScroll)
  }

  mount(parent: BoxRenderable, scrollbarParent = parent): void {
    parent.add(this.scroll)
    scrollbarParent.add(this.scrollbar)
  }

  setViewportRows(rows: number): void {
    this.viewportRows = Math.max(1, rows)
    this.scroll.content.minHeight = this.viewportRows
  }

  update(model: Model, preserveAnchor = false, spinnerGlyph = this.spinnerGlyph): void {
    if (this.destroyed) return
    this.spinnerGlyph = spinnerGlyph
    this.staticContent = false
    const previousModel = this.model
    this.model = model
    const threadChanged = previousModel?.currentThreadId !== model.currentThreadId
    if (threadChanged) {
      this.manualScrollPosition = false
      this.cancelWheelReport()
    }
    const following = threadChanged || isFollowing(this.viewport.mode)
    const layoutChanged =
      previousModel !== undefined &&
      (previousModel.items !== model.items ||
        previousModel.entries !== model.entries ||
        previousModel.blocks !== model.blocks ||
        previousModel.expandedRowKeys !== model.expandedRowKeys ||
        previousModel.width !== model.width ||
        previousModel.height !== model.height)
    const detachedSameThread =
      previousModel !== undefined &&
      previousModel.currentThreadId === model.currentThreadId &&
      !following &&
      (model.entries.length > 0 || model.blocks.length > 0) &&
      layoutChanged &&
      this.pendingPosition === undefined &&
      this.viewport.wheel._tag === "Idle"
    const preservePosition = preserveAnchor || detachedSameThread
    const anchor = preservePosition ? this.geometry.captureAnchor(this.records, this.renderedScrollTop) : undefined
    this.mountAnchorKey = anchor?.key
    if (this.windowThread !== model.currentThreadId) {
      if (this.positionFrame !== undefined) this.renderer.off(CliRenderEvents.FRAME, this.positionFrame)
      this.positionFrame = undefined
      this.pendingPosition = undefined
      this.anchorScrollBy = 0
      this.anchorNearBottom = false
      this.windowThread = model.currentThreadId
      this.windowEnd = model.items.length
      this.bandEnd = Number.POSITIVE_INFINITY
      this.rowTotal = 0
    } else if (preserveAnchor)
      this.windowEnd = Math.min(
        model.items.length,
        this.windowEnd + prependedTranscriptItems(previousModel?.items ?? [], model.items),
      )
    else if ((following && !this.bandRefreshing) || this.windowEnd === 0) {
      this.windowEnd = model.items.length
      this.bandEnd = Number.POSITIVE_INFINITY
    } else
      this.windowEnd =
        model.items.length <= maxMountedTranscriptEntries
          ? model.items.length
          : Math.min(this.windowEnd, model.items.length)
    this.render(spinnerGlyph)
    this.mountAnchorKey = undefined
    if (threadChanged) this.dispatchViewport({ _tag: "ResetCommanded" })
    if (preservePosition) {
      const pending = this.pendingPosition
      const position =
        pending?._tag === "Anchor" && pending.threadId === model.currentThreadId
          ? {
              _tag: "Anchor" as const,
              anchor: pending.anchor,
              threadId: pending.threadId,
              scrollBy: pending.scrollBy + this.anchorScrollBy,
              nearBottom: this.anchorScrollBy === 0 ? pending.nearBottom : this.anchorNearBottom,
            }
          : {
              _tag: "Anchor" as const,
              anchor,
              threadId: model.currentThreadId,
              scrollBy: this.anchorScrollBy,
              nearBottom: this.anchorNearBottom,
            }
      this.anchorScrollBy = 0
      this.anchorNearBottom = false
      this.schedulePosition(position)
    } else if (this.pendingPosition !== undefined) this.renderer.requestRender()
    else if (following && layoutChanged) this.schedulePosition({ _tag: "Follow", threadId: model.currentThreadId })
    else if (!this.scrollbarSyncPending) {
      this.scrollbarSyncPending = true
      this.defer(() => {
        this.scrollbarSyncPending = false
        if (this.model !== undefined) this.syncScrollbar()
      })
    }
  }

  show(child: TextRenderable): void {
    this.clear()
    this.staticContent = true
    this.model = undefined
    this.scroll.content.justifyContent = "flex-start"
    this.topSpacer.height = 0
    this.topSpacer.visible = false
    this.bottomSpacer.height = 0
    this.bottomSpacer.visible = false
    if (this.topSpacer.parent === this.scroll.content) this.scroll.content.remove(this.topSpacer)
    if (this.bottomSpacer.parent === this.scroll.content) this.scroll.content.remove(this.bottomSpacer)
    this.children = [child]
    this.scroll.content.add(child, 0)
    this.schedulePosition({ _tag: "Follow", threadId: undefined })
  }

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

  updateSpinner(glyph: string): void {
    this.spinnerGlyph = glyph
    updateTranscriptSpinners(glyph)(this.records)
  }

  mountedRowCount(): number {
    return this.children.length
  }

  mountedChildren(): ReadonlyArray<TextRenderable> {
    return this.children
  }

  renderRecords(): ReadonlyMap<string, TranscriptRenderableRecord> {
    return this.records
  }

  windowPosition(): number {
    return this.windowEnd
  }

  viewportState(): TranscriptViewport {
    return this.viewport
  }

  pendingAnchorOffset(): number {
    return this.anchorScrollBy
  }

  pendingViewportPosition(): PendingTranscriptPosition | undefined {
    return this.pendingPosition
  }

  synchronizingScrollbar(): boolean {
    return this.scrollbarSyncing
  }

  observeScroll(): void {
    this.handleScroll()
  }

  captureVisibleAnchor(): ViewportAnchor | undefined {
    const anchor = this.geometry.captureAnchor(this.records, this.renderedScrollTop)
    return anchor === undefined ? undefined : { unitId: anchor.key, offset: anchor.screenY }
  }

  dispatch(event: ViewportEvent): void {
    this.dispatchViewport(event)
  }

  synchronizeScrollbar(): void {
    this.syncScrollbar()
  }

  diagnostics(): TranscriptPaneDiagnostics {
    const virtual = this.virtualMetrics()
    return {
      rows: [...this.children],
      keys: [...this.records.keys()],
      windowEnd: this.windowEnd,
      rowTotal: this.rowTotal,
      mountedPhysicalRows: this.mountedRows,
      spacerRowsBefore: this.bandRowsBefore,
      spacerRowsAfter: this.bandRowsAfter,
      following: this.viewport.mode._tag === "Following",
      virtualScrollTop: virtual.rowsAbove + this.scroll.scrollTop,
      virtualScrollHeight: virtual.scrollHeight,
    }
  }

  clear(): void {
    this.handlers.clearWelcome?.()
    for (const child of this.children) {
      this.scroll.content.remove(child)
      child.destroy()
    }
    this.children = []
    this.records.clear()
    this.unitCache.clear()
    this.renderInput = undefined
    this.staticContent = false
    this.manualScrollPosition = false
    this.rowTotal = 0
    this.bandEnd = Number.POSITIVE_INFINITY
    this.bandTotal = 0
    this.mountedBandStart = 0
    this.mountedRows = 0
    this.bandRowsBefore = 0
    this.bandRowsAfter = 0
    this.windowExactRows = 0
    this.bandRowPrefix = [0]
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.scrollGeneration += 1
    this.scrollbarSyncing = false
    if (this.positionFrame !== undefined) this.renderer.off(CliRenderEvents.FRAME, this.positionFrame)
    this.positionFrame = undefined
    this.renderer.off(CliRenderEvents.FRAME, this.recordRenderedScroll)
    this.pendingPosition = undefined
    this.cancelWheelReport()
    this.clear()
    this.scroll.onPositionChanged = undefined
    this.scrollbar.setWheelHandler(undefined)
    this.model = undefined
  }

  private render(toolSpinnerGlyph: string): void {
    const model = this.model
    if (model === undefined) return
    this.scroll.content.justifyContent = "flex-end"
    if (this.children.length === 1 && this.records.size === 0) this.clear()
    const projection = projectTranscriptRows({
      renderer: this.renderer,
      content: this.scroll.content,
      topSpacer: this.topSpacer,
      bottomSpacer: this.bottomSpacer,
      records: this.records,
      children: this.children,
      model,
      windowEnd: this.windowEnd,
      bandEnd: this.bandEnd,
      bandTargetTop: this.bandTargetTop,
      mountAnchorKey: this.mountAnchorKey,
      viewportHeight: this.scroll.viewport.height,
      spinnerGlyph: toolSpinnerGlyph,
      renderInput: this.renderInput,
      unitCache: this.unitCache,
      onToggle: (unitId) => this.handlers.clickToggle?.(unitId),
      openPath: this.handlers.openPath,
    })
    if (projection === undefined) return
    this.unitCache = projection.unitCache
    this.children = projection.children
    this.bandEnd = projection.bandEnd
    this.bandTotal = projection.bandTotal
    this.mountedBandStart = projection.mountedBandStart
    this.bandRowsBefore = projection.rowsBefore
    this.bandRowsAfter = projection.rowsAfter
    this.mountedRows = projection.mountedRows
    this.windowExactRows = projection.rowTotal
    this.bandRowPrefix = projection.rowPrefix
    this.rowTotal = projection.rowTotal
    this.renderInput = projection.input
  }

  private handleScrollBoxSizeChanged(): void {
    this.geometry.synchronize()
    if (
      this.pendingPosition === undefined &&
      !this.manualScrollPosition &&
      (this.staticContent || (this.model !== undefined && isFollowing(this.viewport.mode))) &&
      !this.atBottom()
    )
      this.schedulePosition({ _tag: "Follow", threadId: this.model?.currentThreadId })
  }

  private atBottom(near = false): boolean {
    return (
      atBottomWithin(this.geometry.metrics(), near ? 1 : 0) &&
      this.windowEnd >= (this.model?.items.length ?? 0) &&
      this.bandEnd >= this.bandTotal
    )
  }

  private dispatchViewport(event: ViewportEvent): void {
    const previousMode = this.viewport.mode
    const decision = reduceViewport(this.viewport, event)
    this.viewport = decision.viewport
    if (previousMode !== decision.viewport.mode || event._tag === "ResetCommanded") this.scrollGeneration += 1
    for (const effect of decision.effects)
      switch (effect._tag) {
        case "ProjectState":
          this.scroll.stickyScroll = isFollowing(this.viewport.mode)
          break
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

  private clampScrollTop(scrollTop: number): number {
    return clampScrollTop(scrollTop, { ...this.geometry.metrics(), scrollTop })
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
      this.scroll.scrollTop = this.clampScrollTop(previousTop)
    } finally {
      this.scrollProgrammatic = false
      this.bandTargetTop = undefined
      this.bandRefreshing = false
    }
  }

  private applyPosition(scrollTop: number): void {
    this.geometry.synchronize()
    let target = this.clampScrollTop(scrollTop)
    this.ensureBandsAt(target)
    target = this.clampScrollTop(target)
    if (target === this.scroll.scrollTop) return
    this.scrollProgrammatic = true
    this.scroll.scrollTop = target
    this.scrollProgrammatic = false
  }

  private readingAnchor(): ViewportAnchor | undefined {
    return this.geometry.readingAnchor(this.records, this.renderedScrollTop)
  }

  private handleScroll(): void {
    this.ensureBandsAt(this.scroll.scrollTop)
    if (this.scroll.scrollTop <= this.geometry.overscan() && this.shiftWindow(-100, true)) return
    this.reportScroll()
  }

  private handleWheel(event: MouseEvent): void {
    const direction = event.scroll?.direction
    if (direction !== "up" && direction !== "down") return
    const delta = Math.max(1, event.scroll?.delta ?? 1)
    event.stopPropagation()
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

  private cancelWheelReport(): void {
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
    this.geometry.synchronize()
    const viewportHeight = this.scroll.viewport.height
    const virtual = this.virtualMetrics()
    const scrollHeight = virtual.scrollHeight
    const scrollTop = virtual.rowsAbove + this.scroll.scrollTop
    const overflowing = viewportHeight > 0 && scrollHeight > Math.max(viewportHeight, this.viewportRows)
    this.scrollbarSyncing = true
    try {
      this.scrollbar.scrollSize = scrollHeight
      this.scrollbar.viewportSize = Math.max(1, viewportHeight)
      this.scrollbar.scrollPosition = scrollTop
    } finally {
      this.scrollbarSyncing = false
    }
    if (this.scrollbar.visible !== overflowing) this.scrollbar.visible = overflowing
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

  private schedulePosition(position: Omit<PendingTranscriptPosition, "token">): void {
    const token = this.nextPositionToken
    this.nextPositionToken += 1
    this.pendingPosition = { ...position, token } as PendingTranscriptPosition
    if (this.positionFrame !== undefined) this.renderer.off(CliRenderEvents.FRAME, this.positionFrame)
    const apply = () => {
      this.renderer.off(CliRenderEvents.FRAME, apply)
      if (this.positionFrame === apply) this.positionFrame = undefined
      const current = this.pendingPosition
      if (current === undefined || current.token !== token || this.destroyed) return
      this.pendingPosition = undefined
      if (current.threadId !== this.model?.currentThreadId) return
      if (current._tag === "Follow" && !isFollowing(this.viewport.mode)) return
      if (current._tag === "Anchor") {
        if (isFollowing(this.viewport.mode)) return
        const anchored = current.anchor === undefined ? undefined : this.records.get(current.anchor.key)
        const anchorScreenY = current.anchor?.screenY
        const offset =
          anchored === undefined || anchorScreenY === undefined ? 0 : anchored.renderable.screenY - anchorScreenY
        this.applyPosition(this.scroll.scrollTop + offset + current.scrollBy)
        if (current.scrollBy === 0) this.handlers.scrollGeometry?.(this.scroll.scrollTop)
        else this.reportScroll(current.nearBottom)
      } else {
        this.manualScrollPosition = false
        this.applyPosition(maxScrollTop(this.geometry.metrics()))
      }
      this.syncScrollbar()
      this.renderer.requestRender()
    }
    this.positionFrame = apply
    this.renderer.once(CliRenderEvents.FRAME, apply)
    this.renderer.requestRender()
  }

  private virtualMetrics(): { readonly scrollHeight: number; readonly rowsAbove: number } {
    return this.virtualDocument.metrics({
      model: this.model,
      windowEnd: this.windowEnd,
      bandRowsBefore: this.bandRowsBefore,
      bandRowsAfter: this.bandRowsAfter,
      physicalScrollHeight: this.scroll.scrollHeight,
    })
  }

  private defer(action: () => void): void {
    Effect.runFork(Effect.yieldNow.pipe(Effect.andThen(Effect.sync(action))))
  }
}
