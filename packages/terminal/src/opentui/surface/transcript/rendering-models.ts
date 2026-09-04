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

const sameChunk = (a: TextChunk, b: TextChunk) =>
  a.text === b.text &&
  a.attributes === b.attributes &&
  a.link?.url === b.link?.url &&
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

// Blank lines do not close fences, lists, or reference definitions. Interpret the whole
// source using the durable renderer, while retaining unchanged renderable bands.
const parseMarkdown = (layout: TentativeTranscriptLayout, text: string): void => {
  const trailing = text.charCodeAt(text.length - 1)
  const source = trailing >= 0xd800 && trailing <= 0xdbff ? text.slice(0, -1) : text
  replaceMarkdownTailBands(layout, source.trim().length === 0 ? [] : renderMarkdownLines(source, layout.width))
  layout.sourceLength = text.length
}

const markdownBundles = (key: string, layout: TentativeTranscriptLayout) => {
  const bundles: Array<TranscriptRangeBundle> = []
  for (const [index, band] of layout.markdownTailBands.entries()) {
    const bandKey = `${key}:body:tail:${index}`
    bundles.push({
      key: bandKey,
      rows: band.lines.length,
      descriptors: [
        {
          key: bandKey,
          revision: `${key}:${layout.width}:tail:${index}:${band.revision}`,
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
  if (layout.markdown || tentativeTranscriptContainsMarkdown({ text, sourceLength: layout.sourceLength })) {
    layout.markdown = true
    parseMarkdown(layout, text)
    return { revision, bundles: markdownBundles(key, layout), tentative: layout }
  }
  appendTentativeText(layout, text.slice(layout.sourceLength), text.length)
  return { revision, bundles: plainBundles(key, revision, layout), tentative: layout }
}
