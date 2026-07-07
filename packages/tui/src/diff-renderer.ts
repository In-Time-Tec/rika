import { Common, PierreDiff } from "@rika/schema"
import {
  getFiletypeFromFileName,
  getSharedHighlighter,
  renderDiffWithHighlighter,
  type FileDiffMetadata,
  type ThemedDiffResult,
} from "@pierre/diffs"
import { Effect, Option } from "effect"

export interface DiffToken {
  readonly text: string
  readonly color?: string
}

export type DiffRow =
  | { readonly kind: "separator" }
  | {
      readonly kind: "line"
      readonly marker: " " | "+" | "-"
      readonly line: number
      readonly tokens: ReadonlyArray<DiffToken>
    }

export interface RenderedDiff {
  readonly rows: ReadonlyArray<DiffRow>
  readonly highlighted: boolean
}

export class DiffRenderCache {
  private readonly rendered = new Map<string, RenderedDiff>()

  ensure(fileDiff: Common.JsonValue): Effect.Effect<void> {
    const diff = asFileDiff(fileDiff)
    if (diff === undefined) return Effect.void
    const key = cacheKey(diff)
    if (this.rendered.has(key)) return Effect.void
    return Effect.tryPromise(async () => {
      this.rendered.set(key, await renderHighlighted(diff))
    }).pipe(
      Effect.catch(() =>
        Effect.sync(() => {
          this.rendered.set(key, renderPlain(diff))
        }),
      ),
      Effect.asVoid,
    )
  }

  render(fileDiff: Common.JsonValue): RenderedDiff {
    const diff = asFileDiff(fileDiff)
    if (diff === undefined) return { rows: [], highlighted: false }
    return this.rendered.get(cacheKey(diff)) ?? renderPlain(diff)
  }
}

const theme = "github-dark"
const renderOptions = {
  theme,
  useTokenTransformer: false,
  tokenizeMaxLineLength: 1000,
  lineDiffType: "word-alt",
  maxLineDiffLength: 1000,
} as const

const renderHighlighted = async (diff: FileDiffMetadata): Promise<RenderedDiff> => {
  const language = diff.lang ?? getFiletypeFromFileName(diff.name)
  const highlighter = await getSharedHighlighter({ themes: [theme], langs: [language] })
  const rendered = renderDiffWithHighlighter(diff, highlighter, renderOptions)
  return { rows: limitRows(rowsFromRendered(diff, rendered)), highlighted: true }
}

const rowsFromRendered = (diff: FileDiffMetadata, rendered: ThemedDiffResult): ReadonlyArray<DiffRow> =>
  rowsFromDiff(diff, {
    additions: rendered.code.additionLines.map((line) => stripFinalNewline(tokensFromNode(line))),
    deletions: rendered.code.deletionLines.map((line) => stripFinalNewline(tokensFromNode(line))),
  })

const renderPlain = (diff: FileDiffMetadata): RenderedDiff => ({
  rows: limitRows(
    rowsFromDiff(diff, {
      additions: diff.additionLines.map((line) => [{ text: cleanLine(line), color: "#98c379" }]),
      deletions: diff.deletionLines.map((line) => [{ text: cleanLine(line), color: "#e06c75" }]),
    }),
  ),
  highlighted: false,
})

const rowsFromDiff = (
  diff: FileDiffMetadata,
  lines: {
    readonly additions: ReadonlyArray<ReadonlyArray<DiffToken>>
    readonly deletions: ReadonlyArray<ReadonlyArray<DiffToken>>
  },
): ReadonlyArray<DiffRow> => {
  const rows: Array<DiffRow> = []
  for (const hunk of diff.hunks) {
    if (rows.length > 0 || hunk.collapsedBefore > 0 || hunk.additionStart > 1) rows.push({ kind: "separator" })
    let deletionLine = hunk.deletionStart
    let additionLine = hunk.additionStart
    for (const content of hunk.hunkContent) {
      if (content.type === "context") {
        for (let index = 0; index < content.lines; index += 1) {
          rows.push({
            kind: "line",
            marker: " ",
            line: additionLine,
            tokens:
              lines.additions[content.additionLineIndex + index] ??
              lines.deletions[content.deletionLineIndex + index] ??
              [],
          })
          deletionLine += 1
          additionLine += 1
        }
      } else {
        for (let index = 0; index < content.deletions; index += 1) {
          rows.push({
            kind: "line",
            marker: "-",
            line: deletionLine,
            tokens: lines.deletions[content.deletionLineIndex + index] ?? [],
          })
          deletionLine += 1
        }
        for (let index = 0; index < content.additions; index += 1) {
          rows.push({
            kind: "line",
            marker: "+",
            line: additionLine,
            tokens: lines.additions[content.additionLineIndex + index] ?? [],
          })
          additionLine += 1
        }
      }
    }
  }
  return rows
}

const tokensFromNode = (node: unknown, inheritedColor?: string): ReadonlyArray<DiffToken> => {
  const current = asHast(node)
  if (current === undefined) return []
  if (current.type === "text") {
    const text = typeof current.value === "string" ? current.value : ""
    return text.length === 0 ? [] : [{ text, ...(inheritedColor === undefined ? {} : { color: inheritedColor }) }]
  }
  const color = colorFromStyle(current.properties?.style) ?? inheritedColor
  return (current.children ?? []).flatMap((child) => tokensFromNode(child, color))
}

const stripFinalNewline = (tokens: ReadonlyArray<DiffToken>): ReadonlyArray<DiffToken> => {
  if (tokens.length === 0) return tokens
  const last = tokens[tokens.length - 1]
  if (last === undefined) return tokens
  const text = cleanLine(last.text)
  if (text === last.text) return tokens
  return [...tokens.slice(0, -1), { ...last, text }]
}

const cleanLine = (text: string): string => text.replace(/\r?\n$/, "")

const colorFromStyle = (style: unknown): string | undefined => {
  if (typeof style !== "string") return undefined
  const match = /(?:^|;)\s*color\s*:\s*(#[0-9a-fA-F]{6})/.exec(style)
  return match?.[1]
}

const limitRows = (rows: ReadonlyArray<DiffRow>): ReadonlyArray<DiffRow> => {
  const kept: Array<DiffRow> = []
  let size = 0
  for (const row of rows) {
    const rowSize = row.kind === "separator" ? 3 : row.tokens.reduce((total, token) => total + token.text.length, 0) + 8
    if (kept.length > 0 && size + rowSize > 12000) {
      kept.push({ kind: "separator" })
      return kept
    }
    kept.push(row)
    size += rowSize
  }
  return kept
}

const cacheKey = (diff: FileDiffMetadata): string => diff.cacheKey ?? JSON.stringify(diff)

const asFileDiff = (value: Common.JsonValue): FileDiffMetadata | undefined => {
  const decoded = Option.getOrUndefined(PierreDiff.decodeFileDiffMetadata(value))
  return decoded === undefined ? undefined : toPierreFileDiffMetadata(decoded)
}

type PierreHunk = FileDiffMetadata["hunks"][number]
type PierreHunkContent = PierreHunk["hunkContent"][number]

const toPierreFileDiffMetadata = (diff: PierreDiff.FileDiffMetadata): FileDiffMetadata => ({
  name: diff.name,
  type: diff.type,
  hunks: diff.hunks.map(toPierreHunk),
  splitLineCount: diff.splitLineCount,
  unifiedLineCount: diff.unifiedLineCount,
  isPartial: diff.isPartial,
  deletionLines: [...diff.deletionLines],
  additionLines: [...diff.additionLines],
  ...(diff.prevName === undefined ? {} : { prevName: diff.prevName }),
  ...(diff.lang === undefined ? {} : { lang: diff.lang }),
  ...(diff.newObjectId === undefined ? {} : { newObjectId: diff.newObjectId }),
  ...(diff.prevObjectId === undefined ? {} : { prevObjectId: diff.prevObjectId }),
  ...(diff.mode === undefined ? {} : { mode: diff.mode }),
  ...(diff.prevMode === undefined ? {} : { prevMode: diff.prevMode }),
  ...(diff.cacheKey === undefined ? {} : { cacheKey: diff.cacheKey }),
})

const toPierreHunk = (hunk: PierreDiff.Hunk): PierreHunk => ({
  collapsedBefore: hunk.collapsedBefore,
  additionStart: hunk.additionStart,
  additionCount: hunk.additionCount,
  additionLines: hunk.additionLines,
  additionLineIndex: hunk.additionLineIndex,
  deletionStart: hunk.deletionStart,
  deletionCount: hunk.deletionCount,
  deletionLines: hunk.deletionLines,
  deletionLineIndex: hunk.deletionLineIndex,
  hunkContent: hunk.hunkContent.map(toPierreHunkContent),
  ...(hunk.hunkContext === undefined ? {} : { hunkContext: hunk.hunkContext }),
  ...(hunk.hunkSpecs === undefined ? {} : { hunkSpecs: hunk.hunkSpecs }),
  splitLineStart: hunk.splitLineStart,
  splitLineCount: hunk.splitLineCount,
  unifiedLineStart: hunk.unifiedLineStart,
  unifiedLineCount: hunk.unifiedLineCount,
  noEOFCRDeletions: hunk.noEOFCRDeletions,
  noEOFCRAdditions: hunk.noEOFCRAdditions,
})

const toPierreHunkContent = (content: PierreDiff.HunkContent): PierreHunkContent =>
  content.type === "context"
    ? {
        type: "context",
        lines: content.lines,
        additionLineIndex: content.additionLineIndex,
        deletionLineIndex: content.deletionLineIndex,
      }
    : {
        type: "change",
        deletions: content.deletions,
        deletionLineIndex: content.deletionLineIndex,
        additions: content.additions,
        additionLineIndex: content.additionLineIndex,
      }

const asHast = (
  value: unknown,
):
  | {
      readonly type?: unknown
      readonly value?: unknown
      readonly properties?: { readonly style?: unknown }
      readonly children?: ReadonlyArray<unknown>
    }
  | undefined => (typeof value === "object" && value !== null ? value : undefined)
