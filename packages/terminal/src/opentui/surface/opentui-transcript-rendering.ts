import { TextRenderable, StyledText, fg, type MouseEvent, type TextChunk } from "@opentui/core"
import stringWidth from "string-width"
import { colors } from "../../presentation/terminal/terminal-theme"
import { escapePathTarget } from "../../presentation/transcript/transcript-tool-detail"
import { transcriptUnitBuilder } from "../rendering/opentui-render-unit"
import type { TranscriptUnit } from "../../presentation/transcript/transcript-tool-types"
import { splitStyledLines } from "./opentui-overlay-content"
import type { Model } from "../../state/model/terminal-state"
import { SurfaceState } from "./opentui-surface-state"
import type { TranscriptRangeBundle, TranscriptUnitCacheEntry } from "../rendering/opentui-render-transcript-revision"
import type { TranscriptRenderableDescriptor, TranscriptRenderableRecord } from "./opentui-surface-transcript-types"
import { pinnedRowWindow } from "../../presentation/transcript/transcript-row-window-state"

export abstract class SurfaceTranscriptRendering extends SurfaceState {
  protected abstract restoreFocusedCursor(): void
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
    const previousOrder = new Map(this.transcriptChildren.map((child, index) => [child, index]))
    const positionOf = (record: TranscriptRenderableRecord) => previousOrder.get(record.renderable) ?? -1
    const records = [...desired]
    for (const record of pinned) {
      const previous = positionOf(record)
      const insertion = records.findIndex((candidate) => positionOf(candidate) > previous)
      records.splice(insertion === -1 ? records.length : insertion, 0, record)
    }
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
  protected transcriptChanged(input: {
    readonly entries: Model["entries"]
    readonly blocks: Model["blocks"]
    readonly items: Model["items"]
    readonly expandedRowKeys: Model["expandedRowKeys"]
    readonly detailSelection: Model["detailSelection"]
    readonly width: number
    readonly windowEnd: number
    readonly rowWindowEnd: number
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
      previous.rowWindowEnd !== input.rowWindowEnd ||
      previous.animationTick !== input.animationTick
    )
  }
}
