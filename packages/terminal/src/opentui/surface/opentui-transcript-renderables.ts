import {
  StyledText,
  TextRenderable,
  dim,
  fg,
  italic,
  type BoxRenderable,
  type CliRenderer,
  type MouseEvent,
  type TextChunk,
} from "@opentui/core"
import stringWidth from "string-width"
import {
  mountedTranscriptRowBudget,
  transcriptRenderableBandRows,
} from "../../presentation/transcript/terminal-transcript-window"
import { mergePinnedRecords } from "../../presentation/transcript/transcript-record-order"
import { transcriptUnitId, transcriptUnits } from "../../presentation/transcript/transcript-row"
import { escapePathTarget } from "../../presentation/transcript/transcript-tool-detail"
import type { PathTarget } from "../../presentation/transcript/transcript-tool-detail-types"
import type { TranscriptUnit } from "../../presentation/transcript/transcript-tool-types"
import { colors } from "../../presentation/terminal/terminal-theme"
import { terminalSafeText } from "../../presentation/terminal/terminal-safe-text"
import { boundedTranscriptModel, transcriptWrapWidth } from "../rendering/opentui-render-transcript-window"
import {
  transcriptUnitRevision,
  type TentativeTranscriptLayout,
  type TranscriptRangeBundle,
  type TranscriptUnitCacheEntry,
} from "../rendering/opentui-render-transcript-revision"
import { transcriptUnitBuilder } from "../rendering/opentui-render-unit"
import { wrapTextToWidth } from "../rendering/opentui-render-window"
import { splitStyledLines } from "../rendering/opentui-transcript-styled-lines"
import { toOpenColor } from "../rendering/terminal-text-adapter"
import type { Model } from "../../state/model/terminal-state"
import type {
  TranscriptRenderableDescriptor,
  TranscriptRenderableRecord,
  TranscriptRenderInput,
} from "./opentui-surface-transcript-types"

export type TranscriptRowsCache = Map<string, TranscriptUnitCacheEntry>
export type TranscriptPathTarget = PathTarget

const buildTranscriptUnitBundles = (
  builder: ReturnType<typeof transcriptUnitBuilder>,
  unit: TranscriptUnit,
  revision: string,
  spinnerGlyph: string,
  onToggle: (unitId: string) => void,
): TranscriptUnitCacheEntry => {
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
        range.animated === true ? content.chunks.findIndex((chunk) => chunk.text === spinnerGlyph) : -1
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
                onToggle(range.unit)
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

const buildTentativeTranscriptUnitBundles = (
  key: string,
  text: string,
  width: number,
  tone: TentativeTranscriptLayout["tone"],
  revision: string,
  cached: TranscriptUnitCacheEntry | undefined,
): TranscriptUnitCacheEntry => {
  const previous = cached?.tentative
  const layout: TentativeTranscriptLayout =
    previous === undefined || previous.width !== width || previous.tone !== tone || previous.sourceLength > text.length
      ? { width, tone, sourceLength: 0, pending: "", pendingSource: "", bands: [[]], stableContent: [] }
      : previous
  const sourceDelta = text.slice(layout.sourceLength)
  if (sourceDelta.length > 0) {
    let source = layout.pendingSource + sourceDelta
    const trailing = source.charCodeAt(source.length - 1)
    const deferTrailing = source.endsWith("\r") || (trailing >= 0xd800 && trailing <= 0xdbff)
    layout.pendingSource = deferTrailing ? source.slice(-1) : ""
    if (deferTrailing) source = source.slice(0, -1)
    const rows = wrapTextToWidth(layout.pending + terminalSafeText(source), width)
    for (const row of rows.slice(0, -1)) {
      const band = layout.bands.at(-1)!
      band.push(row)
      if (band.length === transcriptRenderableBandRows) layout.bands.push([])
    }
    layout.pending = rows.at(-1) ?? ""
    layout.sourceLength = text.length
  }
  const content = (value: string): StyledText =>
    new StyledText([tone === "reasoning" ? dim(italic(fg(colors.text)(value))) : fg(colors.text)(value)])
  const bundles: Array<TranscriptRangeBundle> = []
  for (const [index, band] of layout.bands.entries()) {
    const tail = index === layout.bands.length - 1
    const rows = tail ? [...band, layout.pending] : band
    if (rows.length === 0) continue
    const value = rows.join("\n")
    const styled = tail ? content(value) : (layout.stableContent[index] ??= content(value))
    const bandKey = index === 0 ? `${key}:body` : `${key}:body:${index * transcriptRenderableBandRows}`
    bundles.push({
      key: bandKey,
      rows: rows.length,
      descriptors: [
        {
          key: bandKey,
          revision: tail ? `${revision}#${index}` : `${key}:${width}:${index}`,
          content: styled,
          selectable: false,
        },
      ],
    })
  }
  return { revision, bundles, tentative: layout }
}

interface ReconcileTranscriptRenderablesOptions {
  readonly renderer: CliRenderer
  readonly content: BoxRenderable
  readonly topSpacer: BoxRenderable
  readonly bottomSpacer: BoxRenderable
  readonly records: Map<string, TranscriptRenderableRecord>
  readonly children: ReadonlyArray<TextRenderable>
  readonly descriptors: ReadonlyArray<TranscriptRenderableDescriptor>
  readonly openPath: ((target: PathTarget) => void) | undefined
}

const reconcileTranscriptRenderables = ({
  renderer,
  content,
  topSpacer,
  bottomSpacer,
  records,
  children: previousChildren,
  descriptors,
  openPath,
}: ReconcileTranscriptRenderablesOptions): Array<TextRenderable> => {
  const desiredKeys = new Set(descriptors.map((descriptor) => descriptor.key))
  const selection = renderer.getSelection()
  const selected = new Set(selection?.touchedRenderables ?? [])
  const pinned = [...records.values()].filter(
    (record) => !desiredKeys.has(record.key) && selected.has(record.renderable),
  )
  for (const record of records.values()) {
    if (desiredKeys.has(record.key) || selected.has(record.renderable)) continue
    content.remove(record.renderable)
    record.renderable.destroy()
    records.delete(record.key)
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
                openPath?.(target)
                return
              }
              offset = text.indexOf(label, offset + label.length)
            }
          }
      }
      descriptor.onMouseDown?.(event)
    }
    const existing = records.get(descriptor.key)
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
    const renderable = new TextRenderable(renderer, {
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
    records.set(record.key, record)
    return record
  })
  const previousOrder = new Map(previousChildren.map((child, index) => [child, index]))
  const orderedRecords = mergePinnedRecords(desired, pinned, previousOrder)
  const children = orderedRecords.map((record) => record.renderable)
  if (!topSpacer.visible && topSpacer.parent === content) content.remove(topSpacer)
  if (!bottomSpacer.visible && bottomSpacer.parent === content) content.remove(bottomSpacer)
  if (topSpacer.visible && content.getChildren()[0] !== topSpacer) content.add(topSpacer, 0)
  const leading = topSpacer.visible ? 1 : 0
  const current = [...content.getChildren()]
  children.forEach((child, index) => {
    const target = index + leading
    if (current[target] === child) return
    const previous = current.indexOf(child)
    if (previous >= 0) current.splice(previous, 1)
    current.splice(target, 0, child)
    content.add(child, target)
  })
  if (bottomSpacer.visible) {
    const target = leading + children.length
    if (content.getChildren()[target] !== bottomSpacer) content.add(bottomSpacer, target)
  }
  return children
}

export const updateTranscriptSpinners =
  (glyph: string) => (records: ReadonlyMap<string, TranscriptRenderableRecord>) => {
    for (const record of records.values()) {
      if (record.spinnerChunk === undefined) continue
      const content = record.renderable.content
      const chunks = [...content.chunks]
      const chunk = chunks[record.spinnerChunk]
      if (chunk === undefined) continue
      chunks[record.spinnerChunk] = { ...chunk, text: glyph }
      record.renderable.content = new StyledText(chunks)
    }
  }

const transcriptRenderInputChanged = (
  previous: TranscriptRenderInput | undefined,
  input: TranscriptRenderInput,
): boolean =>
  previous === undefined ||
  previous.entries !== input.entries ||
  previous.blocks !== input.blocks ||
  previous.items !== input.items ||
  previous.expandedRowKeys !== input.expandedRowKeys ||
  previous.detailSelection !== input.detailSelection ||
  previous.width !== input.width ||
  previous.windowEnd !== input.windowEnd ||
  previous.animationTick !== input.animationTick

interface ProjectTranscriptRowsOptions {
  readonly renderer: CliRenderer
  readonly content: BoxRenderable
  readonly topSpacer: BoxRenderable
  readonly bottomSpacer: BoxRenderable
  readonly records: Map<string, TranscriptRenderableRecord>
  readonly children: ReadonlyArray<TextRenderable>
  readonly model: Model
  readonly windowEnd: number
  readonly bandEnd: number
  readonly bandTargetTop: number | undefined
  readonly mountAnchorKey: string | undefined
  readonly viewportHeight: number
  readonly spinnerGlyph: string
  readonly renderInput: TranscriptRenderInput | undefined
  readonly unitCache: TranscriptRowsCache
  readonly onToggle: (unitId: string) => void
  readonly openPath: ((target: PathTarget) => void) | undefined
}

export const projectTranscriptRows = (options: ProjectTranscriptRowsOptions) => {
  const { model } = options
  const input = {
    entries: model.entries,
    blocks: model.blocks,
    items: model.items,
    expandedRowKeys: model.expandedRowKeys,
    detailSelection: model.detailSelection,
    width: model.width,
    windowEnd: options.windowEnd,
    animationTick: model.animationTick,
  }
  if (!transcriptRenderInputChanged(options.renderInput, input)) return undefined
  const previousExpandedRows = options.renderInput?.expandedRowKeys
  if (
    previousExpandedRows !== undefined &&
    (previousExpandedRows.length !== model.expandedRowKeys.length ||
      previousExpandedRows.some((row) => !model.expandedRowKeys.includes(row)))
  )
    options.renderer.clearSelection()
  const boundedModel = boundedTranscriptModel(model, options.windowEnd)
  const builder = transcriptUnitBuilder(boundedModel, options.spinnerGlyph)
  const expandedSet = new Set(boundedModel.expandedRowKeys)
  const unitCache: TranscriptRowsCache = new Map()
  const orderedBundles: Array<{
    readonly gapBefore: boolean
    readonly rows: number
    readonly bundle: TranscriptRangeBundle
  }> = []
  let renderedUnits = 0
  for (const unit of transcriptUnits(boundedModel)) {
    if (!builder.isUnitVisible(unit)) continue
    renderedUnits += 1
    const gapBefore = renderedUnits > 1
    const unitKey = transcriptUnitId(boundedModel, unit)
    const revision = transcriptUnitRevision(boundedModel, unit, unitKey, expandedSet)
    const cached = options.unitCache.get(unitKey)
    let tentative: { readonly text: string; readonly tone: "answer" | "reasoning" } | undefined
    if (unitKey.startsWith("entry:tentative:") && unit.kind === "entry")
      tentative = { text: boundedModel.entries[unit.entry]?.text ?? "", tone: "answer" }
    if (unitKey.startsWith("block:tentative:") && unit.kind === "reasoning")
      tentative = {
        text:
          (boundedModel.blocks[unit.block] as { readonly _tag?: string; readonly text?: string } | undefined)?.text ??
          "",
        tone: "reasoning",
      }
    let entry: TranscriptUnitCacheEntry
    if (cached !== undefined && cached.revision === revision) entry = cached
    else if (tentative === undefined)
      entry = buildTranscriptUnitBundles(builder, unit, revision, options.spinnerGlyph, options.onToggle)
    else
      entry = buildTentativeTranscriptUnitBundles(
        unitKey,
        tentative.text,
        transcriptWrapWidth(boundedModel.width),
        tentative.tone,
        revision,
        cached,
      )
    unitCache.set(unitKey, entry)
    for (const [index, bundle] of entry.bundles.entries())
      orderedBundles.push({
        gapBefore: index === 0 && gapBefore,
        rows: bundle.rows + (index === 0 && gapBefore ? 1 : 0),
        bundle,
      })
  }
  const rowPrefix: Array<number> = [0]
  for (const current of orderedBundles) rowPrefix.push(rowPrefix.at(-1)! + current.rows)
  const rowTotal = rowPrefix.at(-1) ?? 0
  let bandEnd = Math.min(
    orderedBundles.length,
    Number.isFinite(options.bandEnd) ? Math.max(0, Math.floor(options.bandEnd)) : orderedBundles.length,
  )
  const budget = mountedTranscriptRowBudget(options.viewportHeight > 0 ? options.viewportHeight : model.height)
  if (rowTotal <= budget) bandEnd = orderedBundles.length
  if (rowTotal > budget && options.mountAnchorKey !== undefined) {
    const anchorBand = orderedBundles.findIndex((current) =>
      current.bundle.descriptors.some((descriptor) => descriptor.key === options.mountAnchorKey),
    )
    if (anchorBand >= 0) bandEnd = anchorBand + 1
  }
  let bandStart = bandEnd
  if (options.bandTargetTop !== undefined) {
    let low = 0
    let high = bandEnd
    while (low < high) {
      const middle = (low + high) >> 1
      if (rowPrefix[middle + 1]! <= options.bandTargetTop) low = middle + 1
      else high = middle
    }
    bandStart = Math.min(low, Math.max(0, bandEnd - 1))
  } else
    while (bandStart > 0 && (bandStart === bandEnd || rowPrefix[bandEnd]! - rowPrefix[bandStart]! < budget))
      bandStart -= 1
  const selection = options.renderer.getSelection()
  const selected = new Set(selection?.touchedRenderables ?? [])
  if (selected.size > 0) {
    const bandByKey = new Map<string, number>()
    for (const [index, current] of orderedBundles.entries())
      for (const descriptor of current.bundle.descriptors) bandByKey.set(descriptor.key, index)
    for (const record of options.records.values()) {
      if (!selected.has(record.renderable)) continue
      const index = bandByKey.get(record.key)
      if (index === undefined) continue
      bandStart = Math.min(bandStart, index)
      bandEnd = Math.max(bandEnd, index + 1)
    }
  }
  const mounted = orderedBundles.slice(bandStart, bandEnd)
  const rowsBefore = rowPrefix[bandStart] ?? 0
  const rowsAfter = Math.max(0, rowTotal - (rowPrefix[bandEnd] ?? rowTotal))
  options.topSpacer.height = rowsBefore
  options.topSpacer.visible = rowsBefore > 0
  options.bottomSpacer.height = rowsAfter
  options.bottomSpacer.visible = rowsAfter > 0
  const descriptors: Array<TranscriptRenderableDescriptor> = []
  for (const { gapBefore, bundle } of mounted) {
    if (gapBefore)
      descriptors.push({
        key: `${bundle.key}:gap`,
        revision: "gap",
        content: new StyledText([fg(toOpenColor(colors.text))(" ")]),
      })
    descriptors.push(...bundle.descriptors)
  }
  const children = reconcileTranscriptRenderables({
    renderer: options.renderer,
    content: options.content,
    topSpacer: options.topSpacer,
    bottomSpacer: options.bottomSpacer,
    records: options.records,
    children: options.children,
    descriptors,
    openPath: options.openPath,
  })
  return {
    input,
    unitCache,
    children,
    bandEnd,
    bandTotal: orderedBundles.length,
    mountedBandStart: bandStart,
    rowsBefore,
    rowsAfter,
    mountedRows: (rowPrefix[bandEnd] ?? 0) - rowsBefore,
    rowTotal,
    rowPrefix,
  }
}
