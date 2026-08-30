import { isFollowing } from "../../../presentation/transcript/viewport/model"
import type { Model } from "../../../state/model"
import { maxMountedTranscriptEntries } from "../../rendering/transcript/window"
import { prependedTranscriptItems } from "./lifecycle"
import { planTranscriptModelUpdate, type TranscriptModelUpdate } from "./model-update"
import { TranscriptPaneRuntime } from "./pane-runtime"
import { projectTranscriptRows } from "./renderables"
import type { PendingTranscriptPosition, TranscriptAnchor } from "./types"

export type { TranscriptPaneDiagnostics, TranscriptPaneHandlers } from "./pane-runtime"

export class TranscriptPane extends TranscriptPaneRuntime {
  update(model: Model, preserveAnchor = false, spinnerGlyph = this.spinnerGlyph): void {
    if (this.destroyed) return
    const previous = this.model
    const plan = planTranscriptModelUpdate({
      previous,
      model,
      viewportFollowing: isFollowing(this.viewport.mode),
      preserveAnchor,
      positionPending: this.pendingPosition !== undefined,
      wheelIdle: this.viewport.wheel._tag === "Idle",
    })
    this.beginUpdate(model, spinnerGlyph, plan)
    const anchor = plan.preservePosition
      ? this.geometry.captureAnchor(this.records, this.renderedScrollTop, this.rowByKey)
      : undefined
    this.mountAnchorKey = anchor?.key
    this.updateWindow(previous, model, preserveAnchor, plan)
    this.render(spinnerGlyph)
    this.mountAnchorKey = undefined
    if (plan.threadChanged) this.dispatchViewport({ _tag: "ResetCommanded" })
    this.finishUpdate(model, previous, anchor, plan)
  }

  private beginUpdate(model: Model, spinnerGlyph: string, plan: TranscriptModelUpdate): void {
    this.spinnerGlyph = spinnerGlyph
    this.staticContent = false
    this.model = model
    if (!plan.threadChanged) return
    this.manualScrollPosition = false
    this.cancelWheelReport()
  }

  private updateWindow(
    previous: Model | undefined,
    model: Model,
    preserveAnchor: boolean,
    plan: TranscriptModelUpdate,
  ): void {
    if (this.windowThread !== model.currentThreadId) {
      this.resetWindow(model)
      return
    }
    if (preserveAnchor) {
      this.windowEnd = Math.min(
        model.items.length,
        this.windowEnd + prependedTranscriptItems(previous?.items ?? [], model.items),
      )
      return
    }
    if ((plan.following && !this.bandRefreshing) || this.windowEnd === 0) {
      this.windowEnd = model.items.length
      this.bandEnd = Number.POSITIVE_INFINITY
      return
    }
    this.windowEnd =
      model.items.length <= maxMountedTranscriptEntries
        ? model.items.length
        : Math.min(this.windowEnd, model.items.length)
  }

  private resetWindow(model: Model): void {
    this.pendingPosition = undefined
    this.anchorScrollBy = 0
    this.anchorNearBottom = false
    this.windowThread = model.currentThreadId
    this.windowEnd = model.items.length
    this.bandEnd = Number.POSITIVE_INFINITY
    this.rowTotal = 0
  }

  private finishUpdate(
    model: Model,
    previous: Model | undefined,
    anchor: TranscriptAnchor | undefined,
    plan: TranscriptModelUpdate,
  ): void {
    if (plan.preservePosition) {
      this.schedulePosition(this.anchorPosition(model, anchor))
      return
    }
    if (this.pendingPosition !== undefined) this.renderer.requestRender()
    else if (plan.following && (previous === undefined || plan.layoutChanged))
      this.schedulePosition({ _tag: "Follow", threadId: model.currentThreadId })
  }

  private anchorPosition(model: Model, anchor: TranscriptAnchor | undefined): PendingTranscriptPosition {
    const pending = this.pendingPosition
    const position: PendingTranscriptPosition =
      pending?._tag === "Anchor" && pending.threadId === model.currentThreadId
        ? {
            ...pending,
            scrollBy: pending.scrollBy + this.anchorScrollBy,
            nearBottom: this.anchorScrollBy === 0 ? pending.nearBottom : this.anchorNearBottom,
          }
        : {
            _tag: "Anchor",
            anchor,
            threadId: model.currentThreadId,
            scrollBy: this.anchorScrollBy,
            nearBottom: this.anchorNearBottom,
          }
    this.anchorScrollBy = 0
    this.anchorNearBottom = false
    return position
  }

  protected render(spinnerGlyph: string): void {
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
      spinnerGlyph,
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
    this.rowByKey = projection.rowByKey
    this.rowTotal = projection.rowTotal
    this.renderInput = projection.input
    this.projectScrollbarVisibility()
  }
}
