import {
  StyledText,
  TextRenderable,
  fg,
  type BoxRenderable,
  type CliRenderer,
  type MouseEvent,
  type TextChunk,
} from "@opentui/core"
import stringWidth from "string-width"
import { Option, Schema } from "effect"
import { Block } from "@rika/transcript/transcript-presentation-model"
import {
  mountedStreamingTranscriptRowBudget,
  mountedTranscriptRowBudget,
  transcriptRenderableBandRows,
} from "../../../presentation/transcript/window"
import { mergePinnedRecords } from "../../../presentation/transcript/record-order"
import { transcriptUnitId, transcriptUnits } from "../../../presentation/transcript/row"
import { escapePathTarget } from "../../../presentation/transcript/tool/detail"
import type { PathTarget } from "../../../presentation/transcript/tool/detail-types"
import type { TranscriptUnit } from "../../../presentation/transcript/tool/types"
import { colors } from "../../../presentation/terminal/theme"
import { boundedTranscriptModel, transcriptWrapWidth } from "../../rendering/transcript/window"
import {
  transcriptUnitRevision,
  type TranscriptRangeBundle,
  type TranscriptUnitCacheEntry,
} from "../../rendering/transcript/revision"
import { transcriptUnitBuilder } from "../../rendering/unit/content"
import { splitStyledLines } from "../../rendering/transcript/styled-lines"
import { toOpenColor } from "../../rendering/text-adapter"
import type { Model } from "../../../state/model"
import type { TranscriptRenderableDescriptor, TranscriptRenderableRecord, TranscriptRenderInput } from "./types"
import {
  buildTentativeTranscriptUnitBundles,
  tentativeTranscriptContainsMarkdown,
  type TranscriptRowsCache,
} from "./rendering-models"

export { tentativeTranscriptContainsMarkdown }
export type { TranscriptRowsCache }
export type TranscriptPathTarget = PathTarget

let transcriptRenderablesCreated = 0
let transcriptRenderablesDestroyed = 0

export const transcriptRenderableDiagnostics = () => ({
  created: transcriptRenderablesCreated,
  destroyed: transcriptRenderablesDestroyed,
})

export const resetTranscriptRenderableDiagnostics = (): void => {
  transcriptRenderablesCreated = 0
  transcriptRenderablesDestroyed = 0
}

const isolateSpinnerChunk = (content: StyledText, spinnerGlyph: string) => {
  const chunkIndex = content.chunks.findIndex((chunk) => chunk.text.includes(spinnerGlyph))
  if (chunkIndex < 0) return { content, spinnerChunk: -1 }
  const chunk = content.chunks[chunkIndex]!
  if (chunk.text === spinnerGlyph) return { content, spinnerChunk: chunkIndex }
  const offset = chunk.text.indexOf(spinnerGlyph)
  const replacement: Array<TextChunk> = []
  const before = chunk.text.slice(0, offset)
  const after = chunk.text.slice(offset + spinnerGlyph.length)
  if (before.length > 0) replacement.push({ ...chunk, text: before })
  const spinnerChunk = chunkIndex + replacement.length
  replacement.push({ ...chunk, text: spinnerGlyph })
  if (after.length > 0) replacement.push({ ...chunk, text: after })
  const chunks = [...content.chunks]
  chunks.splice(chunkIndex, 1, ...replacement)
  return { content: new StyledText(chunks), spinnerChunk }
}

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
      const bandStyled = bandContent(band)
      const isolated =
        range.animated === true && section === "header"
          ? isolateSpinnerChunk(bandStyled, spinnerGlyph)
          : { content: bandStyled, spinnerChunk: -1 }
      const { content, spinnerChunk } = isolated
      const key = start === 0 ? `${range.unit}:${section}` : `${range.unit}:${section}:${lineOffset + start}`
      const baseDescriptor = {
        key,
        revision: `${revision}#${rangeIndex}${section === "header" ? "h" : "b"}:${lineOffset + start}`,
        content,
        selectable: section === "header" ? !range.expandable : true,
        targets: range.targets ?? [],
        pointer: section === "header" && range.expandable,
        onMouseDown: (event: MouseEvent) => {
          if (section !== "header" || !range.expandable || event.button !== 0) return
          event.stopPropagation()
          onToggle(range.unit)
        },
      }
      const descriptor: TranscriptRenderableDescriptor =
        spinnerChunk < 0 ? baseDescriptor : { ...baseDescriptor, spinnerChunk }
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
    transcriptRenderablesDestroyed += 1
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
      existing.renderable.onMouseOver =
        descriptor.pointer === true ? () => renderer.setMousePointer("pointer") : undefined
      existing.renderable.onMouseMove =
        descriptor.pointer === true ? () => renderer.setMousePointer("pointer") : undefined
      existing.renderable.onMouseOut =
        descriptor.pointer === true ? () => renderer.setMousePointer("default") : undefined
      return existing
    }
    const renderable = new TextRenderable(renderer, {
      content: descriptor.content,
      wrapMode: "none",
      selectable: descriptor.selectable ?? true,
    })
    transcriptRenderablesCreated += 1
    renderable.onMouseDown = (event) => handleMouseDown(renderable, event)
    renderable.onMouseOver = descriptor.pointer === true ? () => renderer.setMousePointer("pointer") : undefined
    renderable.onMouseMove = descriptor.pointer === true ? () => renderer.setMousePointer("pointer") : undefined
    renderable.onMouseOut = descriptor.pointer === true ? () => renderer.setMousePointer("default") : undefined
    const record =
      descriptor.spinnerChunk === undefined
        ? { key: descriptor.key, revision: descriptor.revision, renderable }
        : { key: descriptor.key, revision: descriptor.revision, renderable, spinnerChunk: descriptor.spinnerChunk }
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
  children.forEach((child, index) => {
    const target = index + leading
    if (content.getChildren()[target] !== child) content.add(child, target)
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
  previous.explicitlyCollapsedRowKeys !== input.explicitlyCollapsedRowKeys ||
  previous.detailSelection !== input.detailSelection ||
  previous.width !== input.width ||
  previous.windowEnd !== input.windowEnd ||
  previous.animationTick !== input.animationTick ||
  previous.transcriptRevision !== input.transcriptRevision

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

interface OrderedBundle {
  readonly gapBefore: boolean
  readonly rows: number
  readonly bundle: TranscriptRangeBundle
}

const tentativeUnit = (model: Model, unit: TranscriptUnit, unitKey: string) => {
  if (unitKey.startsWith("entry:tentative:") && unit.kind === "entry")
    return { text: model.entries[unit.entry]?.text ?? "", tone: "answer" as const }
  if (!unitKey.startsWith("block:tentative:") || unit.kind !== "reasoning") return undefined
  const block = Option.getOrUndefined(Schema.decodeUnknownOption(Block)(model.blocks[unit.block]))
  return { text: block?._tag === "Reasoning" ? block.text : "", tone: "reasoning" as const }
}

const projectBundles = (options: ProjectTranscriptRowsOptions, model: Model) => {
  const builder = transcriptUnitBuilder(model, options.spinnerGlyph)
  const expandedSet = new Set(model.expandedRowKeys)
  const unitCache: TranscriptRowsCache = new Map()
  const orderedBundles: Array<OrderedBundle> = []
  let renderedUnits = 0
  for (const unit of transcriptUnits(model)) {
    if (!builder.isUnitVisible(unit)) continue
    const gapBefore = renderedUnits++ > 0
    const unitKey = transcriptUnitId(model, unit)
    const revision = transcriptUnitRevision(model, unit, unitKey, expandedSet)
    const cached = options.unitCache.get(unitKey)
    const tentative = tentativeUnit(model, unit, unitKey)
    let entry: TranscriptUnitCacheEntry
    if (cached?.revision === revision) entry = cached
    else if (tentative === undefined)
      entry = buildTranscriptUnitBundles(builder, unit, revision, options.spinnerGlyph, options.onToggle)
    else
      entry = buildTentativeTranscriptUnitBundles({
        key: unitKey,
        text: tentative.text,
        width: transcriptWrapWidth(model.width),
        tone: tentative.tone,
        revision,
        cached,
      })
    unitCache.set(unitKey, entry)
    for (const [index, bundle] of entry.bundles.entries())
      orderedBundles.push({
        gapBefore: index === 0 && gapBefore,
        rows: bundle.rows + (index === 0 && gapBefore ? 1 : 0),
        bundle,
      })
  }
  return { unitCache, orderedBundles }
}

const initialBandRange = (
  options: ProjectTranscriptRowsOptions,
  bundles: ReadonlyArray<OrderedBundle>,
  rowPrefix: ReadonlyArray<number>,
  rowTotal: number,
  budget: number,
) => {
  let end = Math.min(
    bundles.length,
    Number.isFinite(options.bandEnd) ? Math.max(0, Math.floor(options.bandEnd)) : bundles.length,
  )
  if (rowTotal <= budget) end = bundles.length
  if (rowTotal > budget && options.mountAnchorKey !== undefined) {
    const anchor = bundles.findIndex((current) =>
      current.bundle.descriptors.some((descriptor) => descriptor.key === options.mountAnchorKey),
    )
    if (anchor >= 0) end = anchor + 1
  }
  let start = end
  if (options.bandTargetTop === undefined) {
    while (start > 0 && (start === end || rowPrefix[end]! - rowPrefix[start]! < budget)) start -= 1
    return { start, end }
  }
  let low = 0
  let high = end
  while (low < high) {
    const middle = (low + high) >> 1
    if (rowPrefix[middle + 1]! <= options.bandTargetTop) low = middle + 1
    else high = middle
  }
  return { start: Math.min(low, Math.max(0, end - 1)), end }
}

const includeSelectedBands = (
  options: ProjectTranscriptRowsOptions,
  bundles: ReadonlyArray<OrderedBundle>,
  range: { readonly start: number; readonly end: number },
) => {
  const selected = new Set(options.renderer.getSelection()?.touchedRenderables ?? [])
  if (selected.size === 0) return range
  const bandByKey = new Map<string, number>()
  for (const [index, current] of bundles.entries())
    for (const descriptor of current.bundle.descriptors) bandByKey.set(descriptor.key, index)
  let { start, end } = range
  for (const record of options.records.values()) {
    if (!selected.has(record.renderable)) continue
    const index = bandByKey.get(record.key)
    if (index === undefined) continue
    start = Math.min(start, index)
    end = Math.max(end, index + 1)
  }
  return { start, end }
}

const mountedDescriptors = (
  bundles: ReadonlyArray<OrderedBundle>,
  rowPrefix: ReadonlyArray<number>,
  start: number,
  end: number,
) => {
  const descriptors: Array<TranscriptRenderableDescriptor> = []
  const rowByKey = new Map<string, number>()
  for (const [mountedIndex, { gapBefore, bundle }] of bundles.slice(start, end).entries()) {
    const row = rowPrefix[start + mountedIndex] ?? 0
    if (gapBefore) {
      rowByKey.set(`${bundle.key}:gap`, row)
      descriptors.push({
        key: `${bundle.key}:gap`,
        revision: "gap",
        content: new StyledText([fg(toOpenColor(colors.text))(" ")]),
      })
    }
    for (const descriptor of bundle.descriptors) rowByKey.set(descriptor.key, row + (gapBefore ? 1 : 0))
    descriptors.push(...bundle.descriptors)
  }
  return { descriptors, rowByKey }
}

export const projectTranscriptRows = (options: ProjectTranscriptRowsOptions) => {
  const { model } = options
  const input = {
    entries: model.entries,
    blocks: model.blocks,
    items: model.items,
    expandedRowKeys: model.expandedRowKeys,
    explicitlyCollapsedRowKeys: model.explicitlyCollapsedRowKeys,
    detailSelection: model.detailSelection,
    width: model.width,
    windowEnd: options.windowEnd,
    animationTick: model.animationTick,
    transcriptRevision: model.transcriptRevision,
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
  const { unitCache, orderedBundles } = projectBundles(options, boundedModel)
  const rowPrefix: Array<number> = [0]
  for (const current of orderedBundles) rowPrefix.push(rowPrefix.at(-1)! + current.rows)
  const rowTotal = rowPrefix.at(-1) ?? 0
  const preserveStreamingBands = transcriptUnits(model).some((unit) =>
    transcriptUnitId(model, unit).includes(":tentative:"),
  )
  const viewportRows = options.viewportHeight > 0 ? options.viewportHeight : model.height
  const budget = preserveStreamingBands
    ? mountedStreamingTranscriptRowBudget(viewportRows)
    : mountedTranscriptRowBudget(viewportRows)
  const range = includeSelectedBands(
    options,
    orderedBundles,
    initialBandRange(options, orderedBundles, rowPrefix, rowTotal, budget),
  )
  const bandStart = range.start
  const bandEnd = range.end
  const rowsBefore = rowPrefix[bandStart] ?? 0
  const rowsAfter = Math.max(0, rowTotal - (rowPrefix[bandEnd] ?? rowTotal))
  options.topSpacer.height = rowsBefore
  options.topSpacer.visible = rowsBefore > 0
  options.bottomSpacer.height = rowsAfter
  options.bottomSpacer.visible = rowsAfter > 0
  const { descriptors, rowByKey } = mountedDescriptors(orderedBundles, rowPrefix, bandStart, bandEnd)
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
    rowByKey,
  }
}
