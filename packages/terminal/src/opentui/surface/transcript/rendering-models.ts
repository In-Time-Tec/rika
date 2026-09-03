import { StyledText, dim, fg, italic, type TextChunk } from "@opentui/core"
import { terminalSafeText } from "../../../presentation/terminal/safe-text"
import { colors } from "../../../presentation/terminal/theme"
import { transcriptRenderableBandRows } from "../../../presentation/transcript/window"
import { wrapTextToWidth } from "../../rendering/window"
import { renderMarkdownLines } from "../../rendering/text-adapter"
import type {
  TentativeTranscriptLayout,
  TranscriptRangeBundle,
  TranscriptUnitCacheEntry,
} from "../../rendering/transcript/revision"

export type TranscriptRowsCache = Map<string, TranscriptUnitCacheEntry>

export const tentativeTranscriptContainsMarkdown = ({
  text,
  sourceLength,
}: {
  readonly text: string
  readonly sourceLength: number
}) => {
  const probe = text.slice(Math.max(0, sourceLength - 16))
  return (
    /[\\`*[\]<>#|~]/u.test(probe) ||
    /(?:^|\n)[ \t]*(?:[-+>]|\d{1,9}[.)])[ \t]+/u.test(probe) ||
    /(?:^|\n)[ \t]*(?:={2,}|-{3,})[ \t]*(?:\n|$)/u.test(probe) ||
    /(?:^|[^\p{L}\p{N}])_(?=\S)|_(?:$|[^\p{L}\p{N}])/u.test(probe)
  )
}

const newTentativeLayout = (width: number, tone: TentativeTranscriptLayout["tone"]): TentativeTranscriptLayout => ({
  width,
  tone,
  markdown: false,
  sourceLength: 0,
  pending: "",
  pendingSource: "",
  bands: [[]],
  stableContent: [],
  markdownStableLength: 0,
  markdownLastLexedAt: Number.NEGATIVE_INFINITY,
  markdownBands: [[]],
  markdownStableContent: [],
  markdownTailLength: 0,
  markdownTailLexedAt: Number.NEGATIVE_INFINITY,
  markdownTailBands: [],
})

const tentativeLayout = (
  cached: TranscriptUnitCacheEntry | undefined,
  text: string,
  width: number,
  tone: TentativeTranscriptLayout["tone"],
) => {
  const previous = cached?.tentative
  return previous === undefined ||
    previous.width !== width ||
    previous.tone !== tone ||
    previous.sourceLength > text.length
    ? newTentativeLayout(width, tone)
    : previous
}

const toneChunk = (tone: TentativeTranscriptLayout["tone"], chunk: TextChunk) =>
  tone === "reasoning" ? dim(italic(chunk)) : chunk

const styledBand = (tone: TentativeTranscriptLayout["tone"], lines: ReadonlyArray<ReadonlyArray<TextChunk>>) => {
  const chunks: Array<TextChunk> = []
  for (const [index, line] of lines.entries()) {
    for (const chunk of line) chunks.push(toneChunk(tone, chunk))
    if (index < lines.length - 1) chunks.push(fg(colors.text)("\n"))
  }
  return new StyledText(chunks)
}

const appendMarkdownLines = (
  layout: TentativeTranscriptLayout,
  lines: ReadonlyArray<ReadonlyArray<TextChunk>>,
): void => {
  if (layout.markdownStableLength > 0) {
    const last = layout.markdownBands.at(-1)!
    if (last.length === transcriptRenderableBandRows) layout.markdownBands.push([])
    layout.markdownBands.at(-1)!.push([])
    layout.markdownStableContent[layout.markdownBands.length - 1] = undefined
  }
  for (const line of lines) {
    if (layout.markdownBands.at(-1)!.length === transcriptRenderableBandRows) layout.markdownBands.push([])
    layout.markdownBands.at(-1)!.push(line)
    layout.markdownStableContent[layout.markdownBands.length - 1] = undefined
  }
}

const stableMarkdownChunkSize = 512

// The next settle boundary: the first paragraph break at or after one chunk from `offset`, capped at `stableEnd`.
const stableMarkdownBoundary = (text: string, offset: number, stableEnd: number): number => {
  const searchFrom = offset + stableMarkdownChunkSize
  const found = searchFrom >= stableEnd ? -1 : text.indexOf("\n\n", searchFrom)
  return found === -1 || found + 2 > stableEnd ? stableEnd : found + 2
}

// Twice a second, every complete paragraph moves from the re-lexed tail into stable bands that never change again.
// Settling everything available keeps the tail one partial paragraph long however fast the model streams.
const parseStableMarkdown = (layout: TentativeTranscriptLayout, text: string, nowMillis: number): void => {
  if (nowMillis - layout.markdownLastLexedAt < 500) return
  const lastBreak = text.lastIndexOf("\n\n")
  if (lastBreak < layout.markdownStableLength) return
  const stableEnd = lastBreak + 2
  while (layout.markdownStableLength < stableEnd) {
    const boundary = stableMarkdownBoundary(text, layout.markdownStableLength, stableEnd)
    appendMarkdownLines(layout, renderMarkdownLines(text.slice(layout.markdownStableLength, boundary), layout.width))
    layout.markdownStableLength = boundary
  }
  layout.markdownLastLexedAt = nowMillis
  layout.markdownTailLength = 0
  layout.markdownTailLexedAt = Number.NEGATIVE_INFINITY
  layout.markdownTailBands.splice(0)
}

// A paragraph-sized tail is re-lexed on every delta so lists, tables, and emphasis format while they stream. A
// larger tail (a long table or code block without a blank line) is re-lexed at most ten times a second.
const liveMarkdownTailChars = 2048

const sameChunk = (a: TextChunk, b: TextChunk) =>
  a.text === b.text &&
  a.attributes === b.attributes &&
  (a.fg === b.fg || (a.fg !== undefined && a.fg.equals(b.fg))) &&
  (a.bg === b.bg || (a.bg !== undefined && a.bg.equals(b.bg)))

const sameLines = (a: ReadonlyArray<ReadonlyArray<TextChunk>>, b: ReadonlyArray<ReadonlyArray<TextChunk>>) =>
  a.length === b.length &&
  a.every((line, index) => {
    const other = b[index]!
    return line.length === other.length && line.every((chunk, chunkIndex) => sameChunk(chunk, other[chunkIndex]!))
  })

// Only bands whose lines changed receive new content and a new revision, so OpenTUI rebuilds one band per delta.
const replaceMarkdownTailBands = (
  layout: TentativeTranscriptLayout,
  lines: ReadonlyArray<ReadonlyArray<TextChunk>>,
): void => {
  const bands = layout.markdownTailBands
  let index = 0
  for (let start = 0; start < lines.length; start += transcriptRenderableBandRows, index += 1) {
    const bandLines = lines.slice(start, start + transcriptRenderableBandRows)
    const previous = bands[index]
    if (previous !== undefined && sameLines(previous.lines, bandLines)) continue
    bands[index] = {
      lines: bandLines,
      content: styledBand(layout.tone, bandLines),
      revision: previous === undefined ? 0 : previous.revision + 1,
    }
  }
  bands.splice(index)
}

const parseMarkdownTail = (layout: TentativeTranscriptLayout, text: string, nowMillis: number): void => {
  if (text.length === layout.markdownTailLength) return
  const tail = text.slice(layout.markdownStableLength)
  if (tail.length > liveMarkdownTailChars && nowMillis - layout.markdownTailLexedAt < 100) return
  const trailing = tail.charCodeAt(tail.length - 1)
  const source = trailing >= 0xd800 && trailing <= 0xdbff ? tail.slice(0, -1) : tail
  replaceMarkdownTailBands(layout, source.trim().length === 0 ? [] : renderMarkdownLines(source, layout.width))
  layout.markdownTailLength = text.length
  layout.markdownTailLexedAt = nowMillis
  layout.sourceLength = text.length
}

const markdownBundles = (key: string, layout: TentativeTranscriptLayout) => {
  const bundles: Array<TranscriptRangeBundle> = []
  for (const [index, band] of layout.markdownBands.entries()) {
    if (band.length === 0) continue
    const bandKey = index === 0 ? `${key}:body` : `${key}:body:markdown:${index}`
    const content = (layout.markdownStableContent[index] ??= styledBand(layout.tone, band))
    bundles.push({
      key: bandKey,
      rows: band.length,
      descriptors: [
        {
          key: bandKey,
          revision: `${key}:${layout.width}:markdown:${index}:${band.length}`,
          content,
          selectable: false,
        },
      ],
    })
  }
  for (const [index, band] of layout.markdownTailBands.entries()) {
    const bandKey = `${key}:body:tail:${index}`
    bundles.push({
      key: bandKey,
      rows: band.lines.length,
      descriptors: [
        {
          key: bandKey,
          revision: `${key}:${layout.width}:tail:${index}:${layout.markdownStableLength}:${band.revision}`,
          content: band.content,
          selectable: false,
        },
      ],
    })
  }
  return bundles
}

const appendTentativeText = (layout: TentativeTranscriptLayout, sourceDelta: string, textLength: number) => {
  if (sourceDelta.length === 0) return
  let source = layout.pendingSource + sourceDelta
  const trailing = source.charCodeAt(source.length - 1)
  const deferTrailing = source.endsWith("\r") || (trailing >= 0xd800 && trailing <= 0xdbff)
  layout.pendingSource = deferTrailing ? source.slice(-1) : ""
  if (deferTrailing) source = source.slice(0, -1)
  const rows = wrapTextToWidth(layout.pending + terminalSafeText(source), layout.width)
  for (const row of rows.slice(0, -1)) {
    const band = layout.bands.at(-1)!
    band.push(row)
    if (band.length === transcriptRenderableBandRows) layout.bands.push([])
  }
  layout.pending = rows.at(-1) ?? ""
  layout.sourceLength = textLength
}

const plainBundles = (key: string, revision: string, layout: TentativeTranscriptLayout) => {
  const style = (value: string) =>
    new StyledText([layout.tone === "reasoning" ? dim(italic(fg(colors.text)(value))) : fg(colors.text)(value)])
  const bundles: Array<TranscriptRangeBundle> = []
  for (const [index, band] of layout.bands.entries()) {
    const tail = index === layout.bands.length - 1
    const rows = tail ? [...band, layout.pending] : band
    if (rows.length === 0) continue
    const value = rows.join("\n")
    const content = tail ? style(value) : (layout.stableContent[index] ??= style(value))
    const bandKey = index === 0 ? `${key}:body` : `${key}:body:${index * transcriptRenderableBandRows}`
    bundles.push({
      key: bandKey,
      rows: rows.length,
      descriptors: [
        {
          key: bandKey,
          revision: tail ? `${revision}#${index}` : `${key}:${layout.width}:${index}`,
          content,
          selectable: false,
        },
      ],
    })
  }
  return bundles
}

interface BuildTentativeBundlesOptions {
  readonly key: string
  readonly text: string
  readonly width: number
  readonly tone: TentativeTranscriptLayout["tone"]
  readonly revision: string
  readonly cached: TranscriptUnitCacheEntry | undefined
}

export const buildTentativeTranscriptUnitBundles = ({
  key,
  text,
  width,
  tone,
  revision,
  cached,
}: BuildTentativeBundlesOptions): TranscriptUnitCacheEntry => {
  const layout = tentativeLayout(cached, text, width, tone)
  if (tone === "reasoning" || layout.markdown || tentativeTranscriptContainsMarkdown({ text, sourceLength: layout.sourceLength })) {
    layout.markdown = true
    const nowMillis = Number(process.hrtime.bigint()) / 1_000_000
    parseStableMarkdown(layout, text, nowMillis)
    parseMarkdownTail(layout, text, nowMillis)
    return { revision, bundles: markdownBundles(key, layout), tentative: layout }
  }
  appendTentativeText(layout, text.slice(layout.sourceLength), text.length)
  return { revision, bundles: plainBundles(key, revision, layout), tentative: layout }
}
