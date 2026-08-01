import { CliRenderEvents, TextRenderable, StyledText, fg, type MouseEvent, type TextChunk } from "@opentui/core"
import {
  maxMountedTranscriptRows,
  resolveRowEnd,
  shiftRowEnd,
} from "../../presentation/transcript/terminal-transcript-window"
import { pinnedRowWindow } from "../../presentation/transcript/transcript-row-window-state"
import { clampScrollTop, isFollowing } from "../../presentation/transcript/transcript-viewport"
import { maxScrollTop } from "../../presentation/transcript/transcript-viewport-metrics"
import { atBottomWithin } from "../../presentation/transcript/transcript-viewport-metrics"
import { reduceViewport } from "../../presentation/transcript/transcript-viewport-reducer"
import type { ViewportAnchor } from "../../presentation/transcript/transcript-viewport-state"
import type { ViewportEvent } from "../../presentation/transcript/transcript-viewport-events"
import type { ViewportMetrics } from "../../presentation/transcript/transcript-viewport-metrics"
import { colors } from "../../presentation/terminal/terminal-theme"
import { escapePathTarget } from "../../presentation/transcript/transcript-tool-detail"
import { transcriptUnitBuilder } from "../rendering/opentui-render-unit"
import { maxMountedTranscriptEntries } from "../rendering/opentui-render-transcript-window"
import type { TranscriptRangeBundle, TranscriptUnitCacheEntry } from "../rendering/opentui-render-transcript-revision"
import type { TranscriptUnit } from "../../presentation/transcript/transcript-tool-types"
import stringWidth from "string-width"
import { splitStyledLines } from "./opentui-overlay-content"
import type { Model } from "../../state/model/terminal-state"
import { SurfaceState } from "./opentui-surface-state"
import type {
  PendingTranscriptPosition,
  TranscriptAnchor,
  TranscriptRenderableDescriptor,
  TranscriptRenderInput,
} from "./opentui-surface-transcript-types"

export abstract class SurfaceTranscriptRegion extends SurfaceState {
  protected abstract update(model: Model, preserveTranscriptAnchor?: boolean): void
  protected abstract defer(action: () => void): void
  protected abstract restoreFocusedCursor(): void
  protected transcriptMetrics(): ViewportMetrics {
    return {
      scrollTop: this.transcriptScroll.scrollTop,
      scrollHeight: this.transcriptScroll.scrollHeight,
      viewportHeight: this.transcriptScroll.viewport.height,
    }
  }
  protected readonly atMountedTranscriptBottom = (): boolean => atBottomWithin(this.transcriptMetrics(), 1)
  protected readonly atTranscriptBottom = (near = false): boolean =>
    atBottomWithin(this.transcriptMetrics(), near ? 1 : 0) &&
    this.transcriptWindowEnd >= (this.model?.items.length ?? 0) &&
    (this.transcriptRowWindow.end === 0 || this.transcriptRowWindow.end >= this.transcriptRowTotal)
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
  protected applyTranscriptPosition(scrollTop: number): void {
    const target = this.clampTranscriptScrollTop(scrollTop)
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
    const viewportTop = this.transcriptScroll.screenY
    const drift = this.transcriptScroll.scrollTop - this.renderedTranscriptScrollTop
    const first = [...this.transcriptRecords.values()]
      .filter(({ renderable }) => renderable.height > 0 && renderable.screenY + drift + renderable.height > viewportTop)
      .toSorted((left, right) => left.renderable.screenY - right.renderable.screenY)[0]
    return first === undefined ? undefined : { key: first.key, screenY: first.renderable.screenY + drift }
  }
  protected handleTranscriptScroll(): void {
    if (this.transcriptScroll.scrollTop <= 1 && this.shiftTranscriptWindow(-100, true)) return
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
    const limit = maxMountedTranscriptRows
    const currentRowEnd = resolveRowEnd(this.transcriptRowWindow, this.transcriptRowTotal, limit)
    const shiftedRowEnd = shiftRowEnd(this.transcriptRowWindow, delta, this.transcriptRowTotal, limit)
    if (shiftedRowEnd !== currentRowEnd) {
      this.transcriptRowWindow = {
        end: currentRowEnd,
        pendingDelta: delta,
        ...(this.transcriptRowWindow.anchorKey === undefined ? {} : { anchorKey: this.transcriptRowWindow.anchorKey }),
      }
      this.transcriptRenderInput = undefined
      this.transcriptAnchorScrollBy = scrollBy
      this.transcriptAnchorNearBottom = nearBottom
      this.update(model, preserveAnchor)
      return true
    }
    const minimumEnd = Math.min(maxMountedTranscriptEntries, model.items.length)
    const end = Math.min(model.items.length, Math.max(minimumEnd, this.transcriptWindowEnd + delta))
    if (end === this.transcriptWindowEnd) return false
    this.transcriptWindowEnd = end
    if (this.transcriptRowWindow.end !== 0)
      this.transcriptRowWindow = { ...this.transcriptRowWindow, pendingDelta: delta }
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
    const viewportHeight = this.transcriptViewportRows
    const scrollHeight = this.transcriptScroll.scrollHeight
    const overflowing = viewportHeight > 0 && scrollHeight > viewportHeight
    this.transcriptScrollbar.scrollSize = scrollHeight
    this.transcriptScrollbar.viewportSize = Math.max(1, viewportHeight)
    this.scrollbarSyncing = true
    this.transcriptScrollbar.scrollPosition = this.transcriptScroll.scrollTop
    this.scrollbarSyncing = false
    if (this.transcriptScrollbar.visible !== overflowing) this.transcriptScrollbar.visible = overflowing
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
          anchored === undefined || anchorScreenY === undefined
            ? this.transcriptScroll.scrollHeight - current.scrollHeight
            : anchored.renderable.screenY - anchorScreenY
        this.applyTranscriptPosition(this.transcriptScroll.scrollTop + offset + current.scrollBy)
        if (current.scrollBy === 0) this.handlers.scrollGeometry?.(this.transcriptScroll.scrollTop)
        else this.reportTranscriptScroll(current.nearBottom)
      } else this.applyTranscriptPosition(maxScrollTop(this.transcriptMetrics()))
      this.syncTranscriptScrollbar()
      this.renderer.requestRender()
    }
    this.transcriptPositionFrame = apply
    this.renderer.once(CliRenderEvents.FRAME, apply)
    this.clock.setTimeout(() => {
      if (this.transcriptPositionFrame === apply && !this.destroyed) apply()
    }, 16)
  }

  protected clearTranscriptChildren(): void {
    this.welcomeChild = undefined
    for (const child of this.transcriptChildren) {
      this.transcriptScroll.content.remove(child)
      child.destroy()
    }
    this.transcriptChildren = []
    this.transcriptRecords.clear()
    this.transcriptUnitCache.clear()
    this.transcriptRenderInput = undefined
    this.transcriptRowWindow = pinnedRowWindow
    this.transcriptRowTotal = 0
  }
  protected buildTranscriptUnitBundles(
    builder: ReturnType<typeof transcriptUnitBuilder>,
    unit: TranscriptUnit,
    revision: string,
    toolSpinnerGlyph: string,
  ): TranscriptUnitCacheEntry {
    const built = builder.renderUnit(unit)
    const styledLines = splitStyledLines(new StyledText([...built.chunks]))
    const bundles: Array<TranscriptRangeBundle> = []
    const ranges = [built.root, ...built.nested]
    for (const [rangeIndex, range] of ranges.entries()) {
      const descriptors: Array<TranscriptRenderableDescriptor> = []
      const headerEnd = range.headerEnd ?? range.start
      const header: Array<TextChunk> = []
      const headerLines = styledLines.slice(range.start, headerEnd + 1)
      for (const [index, current] of headerLines.entries()) {
        header.push(...current)
        if (index < headerLines.length - 1) header.push(fg(colors.text)("\n"))
      }
      const headerContent = new StyledText(header)
      const spinnerChunk =
        range.animated === true ? headerContent.chunks.findIndex((chunk) => chunk.text === toolSpinnerGlyph) : -1
      descriptors.push({
        key: `${range.unit}:header`,
        revision: `${revision}#${rangeIndex}h`,
        content: headerContent,
        selectable: !range.expandable,
        ...(range.targets === undefined ? {} : { targets: range.targets }),
        ...(spinnerChunk < 0 ? {} : { spinnerChunk }),
        ...(range.expandable
          ? {
              onMouseDown: (event: MouseEvent) => {
                if (event.button !== 0) return
                event.stopPropagation()
                this.handlers.clickToggle?.(range.unit)
              },
            }
          : {}),
      })
      const body: Array<TextChunk> = []
      const bodyLines = styledLines.slice(headerEnd + 1, range.end + 1)
      for (const [index, line] of bodyLines.entries()) {
        body.push(...line)
        if (index < bodyLines.length - 1) body.push(fg(colors.text)("\n"))
      }
      if (body.length > 0)
        descriptors.push({
          key: `${range.unit}:body`,
          revision: `${revision}#${rangeIndex}b`,
          content: new StyledText(body),
          ...(range.targets === undefined ? {} : { targets: range.targets }),
        })
      bundles.push({ key: range.unit, descriptors })
    }
    return { revision, bundles }
  }
  protected setWelcomeChild(child: TextRenderable): void {
    this.clearTranscriptChildren()
    this.transcriptChildren = [child]
    this.transcriptScroll.content.add(child)
  }
  protected reconcileTranscript(descriptors: ReadonlyArray<TranscriptRenderableDescriptor>): void {
    if (this.welcomeChild !== undefined) this.clearTranscriptChildren()
    const desiredKeys = new Set(descriptors.map((descriptor) => descriptor.key))
    const selection = this.renderer.getSelection()
    const selected = new Set(selection?.touchedRenderables ?? [])
    const pinned = [...this.transcriptRecords.values()].filter(
      (record) => !desiredKeys.has(record.key) && selected.has(record.renderable),
    )
    for (const record of this.transcriptRecords.values()) {
      if (desiredKeys.has(record.key) || selected.has(record.renderable)) continue
      this.transcriptScroll.content.remove(record.renderable)
      record.renderable.destroy()
      this.transcriptRecords.delete(record.key)
    }
    const desired = descriptors.map((descriptor) => {
      const handleMouseDown = (renderable: TextRenderable, event: MouseEvent) => {
        if (event.button === 0) {
          const row = event.y - renderable.screenY
          const column = event.x - renderable.screenX
          const text = descriptor.content.chunks
            .map((chunk) => chunk.text)
            .join("")
            .split("\n")[row]
          if (text !== undefined)
            for (const target of descriptor.targets ?? []) {
              const label = escapePathTarget(target.path)
              let offset = text.indexOf(label)
              while (offset >= 0) {
                const start = stringWidth(text.slice(0, offset))
                const end = start + stringWidth(label)
                if (column >= start && column < end) {
                  event.stopPropagation()
                  this.handlers.openPath?.(target)
                  this.restoreFocusedCursor()
                  return
                }
                offset = text.indexOf(label, offset + label.length)
              }
            }
        }
        descriptor.onMouseDown?.(event)
        this.restoreFocusedCursor()
      }
      const existing = this.transcriptRecords.get(descriptor.key)
      if (existing !== undefined) {
        if (existing.revision !== descriptor.revision) {
          existing.revision = descriptor.revision
          existing.renderable.content = descriptor.content
        }
        if (descriptor.spinnerChunk === undefined) delete existing.spinnerChunk
        else existing.spinnerChunk = descriptor.spinnerChunk
        existing.renderable.selectable = descriptor.selectable ?? true
        existing.renderable.onMouseDown = (event) => handleMouseDown(existing.renderable, event)
        return existing
      }
      const renderable = new TextRenderable(this.renderer, {
        content: descriptor.content,
        wrapMode: "none",
        selectable: descriptor.selectable ?? true,
      })
      renderable.onMouseDown = (event) => handleMouseDown(renderable, event)
      const record = {
        key: descriptor.key,
        revision: descriptor.revision,
        renderable,
        ...(descriptor.spinnerChunk === undefined ? {} : { spinnerChunk: descriptor.spinnerChunk }),
      }
      this.transcriptRecords.set(record.key, record)
      return record
    })
    const records = [...pinned, ...desired]
    const children = records.map((record) => record.renderable)
    const current = [...this.transcriptScroll.content.getChildren()]
    children.forEach((child, index) => {
      if (current[index] === child) return
      const previous = current.indexOf(child)
      if (previous >= 0) current.splice(previous, 1)
      current.splice(index, 0, child)
      this.transcriptScroll.content.add(child, index)
    })
    this.transcriptChildren = children
  }
  protected transcriptChanged(input: TranscriptRenderInput): boolean {
    const previous = this.transcriptRenderInput
    return (
      previous === undefined ||
      previous.entries !== input.entries ||
      previous.blocks !== input.blocks ||
      previous.items !== input.items ||
      previous.expandedRowKeys !== input.expandedRowKeys ||
      previous.detailSelection !== input.detailSelection ||
      previous.width !== input.width ||
      previous.windowEnd !== input.windowEnd ||
      previous.rowWindowEnd !== input.rowWindowEnd
    )
  }
}
