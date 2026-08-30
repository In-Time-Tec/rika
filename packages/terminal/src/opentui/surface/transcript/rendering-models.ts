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

const markdownBundles = (key: string, text: string, width: number, revision: string) => {
  const bundles: Array<TranscriptRangeBundle> = []
  const lines = renderMarkdownLines(text.trimEnd(), width)
  for (let start = 0; start < lines.length; start += transcriptRenderableBandRows) {
    const band = lines.slice(start, start + transcriptRenderableBandRows)
    const chunks: Array<TextChunk> = []
    for (const [index, line] of band.entries()) {
      chunks.push(...line)
      if (index < band.length - 1) chunks.push(fg(colors.text)("\n"))
    }
    const bandKey = start === 0 ? `${key}:body` : `${key}:body:${start}`
    bundles.push({
      key: bandKey,
      rows: band.length,
      descriptors: [
        { key: bandKey, revision: `${revision}#${start}`, content: new StyledText(chunks), selectable: false },
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
  if (
    tone === "answer" &&
    (layout.markdown || tentativeTranscriptContainsMarkdown({ text, sourceLength: layout.sourceLength }))
  ) {
    layout.markdown = true
    layout.sourceLength = text.length
    return { revision, bundles: markdownBundles(key, text, width, revision), tentative: layout }
  }
  appendTentativeText(layout, text.slice(layout.sourceLength), text.length)
  return { revision, bundles: plainBundles(key, revision, layout), tentative: layout }
}
