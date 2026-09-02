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

const styledBand = (lines: ReadonlyArray<ReadonlyArray<TextChunk>>) => {
  const chunks: Array<TextChunk> = []
  for (const [index, line] of lines.entries()) {
    chunks.push(...line)
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

const stableMarkdownBoundary = (text: string, offset: number): number => {
  const limit = Math.min(text.length, offset + stableMarkdownChunkSize)
  const boundary = text.lastIndexOf("\n\n", limit - 1)
  return boundary < 0 ? 0 : boundary + 2
}

const parseStableMarkdown = (layout: TentativeTranscriptLayout, text: string, nowMillis: number): void => {
  if (nowMillis - layout.markdownLastLexedAt < 500) return
  const boundary = stableMarkdownBoundary(text, layout.markdownStableLength)
  if (boundary <= layout.markdownStableLength) return
  const stableSource = text.slice(layout.markdownStableLength, boundary)
  appendMarkdownLines(layout, renderMarkdownLines(stableSource, layout.width))
  layout.markdownStableLength = boundary
  layout.markdownLastLexedAt = nowMillis
  layout.pending = ""
  layout.pendingSource = ""
  layout.bands.splice(0, layout.bands.length, [])
  layout.stableContent.splice(0)
  layout.sourceLength = boundary
  appendTentativeText(layout, text.slice(boundary), text.length)
}

const markdownBundles = (key: string, revision: string, layout: TentativeTranscriptLayout) => {
  const bundles: Array<TranscriptRangeBundle> = []
  let row = 0
  for (const [index, band] of layout.markdownBands.entries()) {
    if (band.length === 0) continue
    const bandKey = row === 0 ? `${key}:body` : `${key}:body:${row}`
    const content = (layout.markdownStableContent[index] ??= styledBand(band))
    bundles.push({
      key: bandKey,
      rows: band.length,
      descriptors: [{ key: bandKey, revision: `${key}:${layout.width}:markdown:${index}`, content, selectable: false }],
    })
    row += band.length
  }
  const style = (value: string) => new StyledText([fg(colors.text)(value)])
  for (const [index, band] of layout.bands.entries()) {
    const tail = index === layout.bands.length - 1
    const rows = tail ? [...band, layout.pending] : band
    if (rows.length === 0 || (rows.length === 1 && rows[0] === "")) continue
    const value = rows.join("\n")
    const content = tail ? style(value) : (layout.stableContent[index] ??= style(value))
    const bandKey = row === 0 ? `${key}:body` : `${key}:body:${row}`
    bundles.push({
      key: bandKey,
      rows: rows.length,
      descriptors: [
        {
          key: bandKey,
          revision: tail ? `${revision}#tail:${index}` : `${key}:${layout.width}:tail:${index}`,
          content,
          selectable: false,
        },
      ],
    })
    row += rows.length
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
  if (
    tone === "answer" &&
    (layout.markdown || tentativeTranscriptContainsMarkdown({ text, sourceLength: layout.sourceLength }))
  ) {
    layout.markdown = true
    parseStableMarkdown(layout, text, Number(process.hrtime.bigint()) / 1_000_000)
    appendTentativeText(layout, text.slice(layout.sourceLength), text.length)
    return { revision, bundles: markdownBundles(key, revision, layout), tentative: layout }
  }
  appendTentativeText(layout, text.slice(layout.sourceLength), text.length)
  return { revision, bundles: plainBundles(key, revision, layout), tentative: layout }
}
