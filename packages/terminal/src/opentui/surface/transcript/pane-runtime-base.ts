import {
  BoxRenderable,
  CliRenderEvents,
  TextRenderable,
  type CliRenderer,
  type Clock as OpenTuiClock,
  type MouseEvent,
  type TimerHandle,
} from "@opentui/core"
import { initialViewport, type TranscriptViewport } from "../../../presentation/transcript/viewport/state"
import { colors, spacing } from "../../../presentation/terminal/theme"
import type { Model } from "../../../state/model"
import { toOpenColor } from "../../rendering/text-adapter"
import { cutoutBackground } from "../renderables"
import type { PendingTranscriptPosition, TranscriptRenderableRecord, TranscriptRenderInput } from "./types"
import {
  TranscriptPaneGeometry,
  TranscriptPaneFrame,
  TranscriptScrollBarRenderable,
  TranscriptScrollBoxRenderable,
} from "./pane-geometry"
import { updateTranscriptSpinners, type TranscriptPathTarget, type TranscriptRowsCache } from "./renderables"
import { TranscriptVirtualDocument } from "./virtual-document"

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

export abstract class TranscriptPaneRuntimeBase {
  readonly scroll: TranscriptScrollBoxRenderable
  readonly scrollbar: TranscriptScrollBarRenderable
  readonly topSpacer: BoxRenderable
  readonly bottomSpacer: BoxRenderable
  protected readonly handlers: TranscriptPaneHandlers
  protected model: Model | undefined
  protected children: Array<TextRenderable> = []
  protected records = new Map<string, TranscriptRenderableRecord>()
  protected unitCache: TranscriptRowsCache = new Map()
  protected renderInput: TranscriptRenderInput | undefined
  protected scrollProgrammatic = false
  protected wheelTimer: TimerHandle | undefined
  protected viewport: TranscriptViewport = initialViewport
  protected viewportRows = 0
  protected renderedScrollTop = 0
  protected windowEnd = 0
  protected rowTotal = 0
  protected bandEnd = Number.POSITIVE_INFINITY
  protected bandTotal = 0
  protected mountedBandStart = 0
  protected mountedRows = 0
  protected bandRowsBefore = 0
  protected bandRowsAfter = 0
  protected windowExactRows = 0
  protected bandRowPrefix: ReadonlyArray<number> = [0]
  protected rowByKey: ReadonlyMap<string, number> = new Map()
  protected mountAnchorKey: string | undefined
  protected bandRefreshing = false
  protected bandTargetTop: number | undefined
  protected readonly virtualDocument = new TranscriptVirtualDocument()
  protected windowThread: string | undefined
  protected anchorScrollBy = 0
  protected anchorNearBottom = false
  protected pendingPosition: PendingTranscriptPosition | undefined
  protected scrollbarSyncing = false
  protected scrollGeneration = 0
  protected manualScrollPosition = false
  protected spinnerGlyph = ""
  protected staticContent = false
  protected destroyed = false
  protected readonly geometry: TranscriptPaneGeometry
  protected readonly frame: TranscriptPaneFrame
  private readonly recordRenderedScroll = () => {
    this.synchronizeGeometry()
    this.renderedScrollTop = this.scroll.scrollTop
  }

  constructor(
    protected readonly renderer: CliRenderer,
    protected readonly options: { readonly clock: OpenTuiClock; readonly handlers?: TranscriptPaneHandlers },
  ) {
    this.handlers = options.handlers ?? {}
    const background = cutoutBackground(renderer)
    this.scroll = new TranscriptScrollBoxRenderable(renderer, {
      flexGrow: 1,
      scrollY: true,
      stickyScroll: false,
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
    this.frame = new TranscriptPaneFrame(renderer, () => this.settleFrame())
    const viewportSizeChange = this.scroll.viewport.onSizeChange
    this.scroll.viewport.onSizeChange = () => {
      viewportSizeChange?.call(this.scroll.viewport)
      this.frame.settleNow()
    }
    const contentSizeChange = this.scroll.content.onSizeChange
    this.scroll.content.onSizeChange = () => {
      contentSizeChange?.call(this.scroll.content)
      this.frame.settleNow()
    }
    this.scroll.focusable = false
    this.scroll.verticalScrollBar.focusable = false
    this.scroll.verticalScrollBar.visible = false
    this.scroll.onPositionChanged = () => this.handlePositionChanged()
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
      onChange: (position) => this.handleScrollbarChanged(position),
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
    this.projectScrollbarVisibility()
  }

  abstract update(model: Model, preserveAnchor?: boolean, spinnerGlyph?: string): void

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
    this.scrollbar.visible = false
    this.schedulePosition({ _tag: "Follow", threadId: undefined })
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
    this.rowByKey = new Map()
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.scrollGeneration += 1
    this.scrollbarSyncing = false
    this.frame.destroy()
    this.renderer.off(CliRenderEvents.FRAME, this.recordRenderedScroll)
    this.pendingPosition = undefined
    this.cancelWheelReport()
    this.clear()
    this.scroll.onPositionChanged = undefined
    this.scrollbar.setWheelHandler(undefined)
    this.model = undefined
  }

  protected abstract cancelWheelReport(): void
  protected abstract handlePositionChanged(): void
  protected abstract handleScroll(): void
  protected abstract handleScrollbarChanged(position: number): void
  protected abstract handleWheel(event: MouseEvent): void
  protected abstract projectScrollbarVisibility(): void
  protected abstract render(toolSpinnerGlyph: string): void
  protected abstract schedulePosition(position: PendingTranscriptPosition): void
  protected abstract settleFrame(): void
  protected abstract synchronizeGeometry(): void
  protected abstract virtualMetrics(physicalScrollHeight?: number): {
    readonly scrollHeight: number
    readonly rowsAbove: number
  }
}
