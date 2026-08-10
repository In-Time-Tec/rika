import { TextRenderable, StyledText, fg, type MouseEvent, type TextChunk } from "@opentui/core"
import stringWidth from "string-width"
import { colors } from "../../presentation/terminal/terminal-theme"
import { transcriptRenderableBandRows } from "../../presentation/transcript/terminal-transcript-window"
import { escapePathTarget } from "../../presentation/transcript/transcript-tool-detail"
import { transcriptUnitBuilder } from "../rendering/opentui-render-unit"
import type { TranscriptUnit } from "../../presentation/transcript/transcript-tool-types"
import { splitStyledLines } from "./opentui-overlay-content"
import { mergePinnedRecords } from "../../presentation/transcript/transcript-record-order"
import type { Model } from "../../state/model/terminal-state"
import { SurfaceState } from "./opentui-surface-state"
import type { TranscriptRangeBundle, TranscriptUnitCacheEntry } from "../rendering/opentui-render-transcript-revision"
import type { TranscriptRenderableDescriptor } from "./opentui-surface-transcript-types"

export abstract class SurfaceTranscriptRendering extends SurfaceState {
  protected abstract restoreFocusedCursor(): void
  protected clearTranscriptChildren(): void {
    this.welcomeController.clear()
    for (const child of this.transcriptChildren) {
      this.transcriptScroll.content.remove(child)
      child.destroy()
    }
    this.transcriptChildren = []
    this.transcriptRecords.clear()
    this.transcriptUnitCache.clear()
    this.transcriptRenderInput = undefined
    this.transcriptRowTotal = 0
    this.transcriptBandEnd = Number.POSITIVE_INFINITY
    this.transcriptBandTotal = 0
    this.transcriptMountedBandStart = 0
    this.transcriptMountedRows = 0
    this.transcriptBandRowsBefore = 0
    this.transcriptBandRowsAfter = 0
    this.transcriptWindowExactRows = 0
    this.transcriptBandRowPrefix = [0]
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
    const bandContent = (lines: ReadonlyArray<ReadonlyArray<TextChunk>>): StyledText => {
      const chunks: Array<TextChunk> = []
      for (const [index, line] of lines.entries()) {
        chunks.push(...line)
        if (index < lines.length - 1) chunks.push(fg(colors.text)("\n"))
      }
      return new StyledText(chunks)
    }
    const appendBands = (
      range: (typeof built)["root"],
      rangeIndex: number,
      section: "header" | "body",
      lines: ReadonlyArray<ReadonlyArray<TextChunk>>,
      lineOffset: number,
    ) => {
      for (let start = 0; start < lines.length; start += transcriptRenderableBandRows) {
        const band = lines.slice(start, start + transcriptRenderableBandRows)
        const content = bandContent(band)
        const key = start === 0 ? `${range.unit}:${section}` : `${range.unit}:${section}:${lineOffset + start}`
        const spinnerChunk =
          range.animated === true ? content.chunks.findIndex((chunk) => chunk.text === toolSpinnerGlyph) : -1
        const descriptor: TranscriptRenderableDescriptor = {
          key,
          revision: `${revision}#${rangeIndex}${section === "header" ? "h" : "b"}:${lineOffset + start}`,
          content,
          ...(section === "header" ? { selectable: !range.expandable } : {}),
          ...(range.targets === undefined ? {} : { targets: range.targets }),
          ...(spinnerChunk < 0 ? {} : { spinnerChunk }),
          ...(section === "header" && range.expandable
            ? {
                onMouseDown: (event: MouseEvent) => {
                  if (event.button !== 0) return
                  event.stopPropagation()
                  this.handlers.clickToggle?.(range.unit)
                },
              }
            : {}),
        }
        bundles.push({ key, rows: band.length, descriptors: [descriptor] })
      }
    }
    for (const [rangeIndex, range] of [built.root, ...built.nested].entries()) {
      const headerEnd = range.headerEnd ?? range.start
      appendBands(range, rangeIndex, "header", styledLines.slice(range.start, headerEnd + 1), range.start)
      appendBands(range, rangeIndex, "body", styledLines.slice(headerEnd + 1, range.end + 1), headerEnd + 1)
    }
    return { revision, bundles }
  }
  protected setWelcomeChild(child: TextRenderable): void {
    this.clearTranscriptChildren()
    this.transcriptTopSpacer.height = 0
    this.transcriptTopSpacer.visible = false
    this.transcriptBottomSpacer.height = 0
    this.transcriptBottomSpacer.visible = false
    if (this.transcriptTopSpacer.parent === this.transcriptScroll.content)
      this.transcriptScroll.content.remove(this.transcriptTopSpacer)
    if (this.transcriptBottomSpacer.parent === this.transcriptScroll.content)
      this.transcriptScroll.content.remove(this.transcriptBottomSpacer)
    this.transcriptChildren = [child]
    this.transcriptScroll.content.add(child, 0)
  }
  protected reconcileTranscript(descriptors: ReadonlyArray<TranscriptRenderableDescriptor>): void {
    if (this.welcomeController.child !== undefined) this.clearTranscriptChildren()
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
    const previousOrder = new Map(this.transcriptChildren.map((child, index) => [child, index]))
    const records = mergePinnedRecords(desired, pinned, previousOrder)
    const children = records.map((record) => record.renderable)
    if (!this.transcriptTopSpacer.visible && this.transcriptTopSpacer.parent === this.transcriptScroll.content)
      this.transcriptScroll.content.remove(this.transcriptTopSpacer)
    if (!this.transcriptBottomSpacer.visible && this.transcriptBottomSpacer.parent === this.transcriptScroll.content)
      this.transcriptScroll.content.remove(this.transcriptBottomSpacer)
    if (this.transcriptTopSpacer.visible && this.transcriptScroll.content.getChildren()[0] !== this.transcriptTopSpacer)
      this.transcriptScroll.content.add(this.transcriptTopSpacer, 0)
    const leading = this.transcriptTopSpacer.visible ? 1 : 0
    const current = [...this.transcriptScroll.content.getChildren()]
    children.forEach((child, index) => {
      const target = index + leading
      if (current[target] === child) return
      const previous = current.indexOf(child)
      if (previous >= 0) current.splice(previous, 1)
      current.splice(target, 0, child)
      this.transcriptScroll.content.add(child, target)
    })
    if (this.transcriptBottomSpacer.visible) {
      const target = leading + children.length
      if (this.transcriptScroll.content.getChildren()[target] !== this.transcriptBottomSpacer)
        this.transcriptScroll.content.add(this.transcriptBottomSpacer, target)
    }
    this.transcriptChildren = children
  }
  protected transcriptChanged(input: {
    readonly entries: Model["entries"]
    readonly blocks: Model["blocks"]
    readonly items: Model["items"]
    readonly expandedRowKeys: Model["expandedRowKeys"]
    readonly detailSelection: Model["detailSelection"]
    readonly width: number
    readonly windowEnd: number
    readonly animationTick: number
  }): boolean {
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
      previous.animationTick !== input.animationTick
    )
  }
}
