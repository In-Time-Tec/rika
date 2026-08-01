import { StyledText, type TextChunk } from "@opentui/core"
import type { TerminalStyledText, TerminalTextChunk } from "../../presentation/markdown/styled-text"
import {
  renderDiffStyled as diffStyled,
  renderPartialDiffStyled as partialDiffStyled,
} from "../../presentation/tool/diff-renderer"
import { renderPierreDiff as pierreDiff, type DiffRenderOptions } from "../../presentation/tool/pierre-diff-adapter"
import { renderToolSummary as toolSummary } from "../../presentation/tool/tool-summary"
const toOpenChunk = (chunk: TerminalTextChunk): TextChunk =>
  ({
    __isChunk: true,
    text: chunk.text,
    ...(chunk.fg === undefined ? {} : { fg: chunk.fg }),
    ...(chunk.bg === undefined ? {} : { bg: chunk.bg }),
    ...(chunk.attributes === undefined ? {} : { attributes: chunk.attributes }),
    ...(chunk.link === undefined ? {} : { link: chunk.link }),
  }) as unknown as TextChunk
const toOpenText = (text: TerminalStyledText): StyledText => new StyledText(text.chunks.map(toOpenChunk))

export const renderDiffStyled = (patch: string, options: Parameters<typeof diffStyled>[1]): StyledText =>
  toOpenText(diffStyled(patch, options))
export const renderPartialDiffStyled = (
  patch: string,
  options: Parameters<typeof partialDiffStyled>[1],
): StyledText | undefined => {
  const result = partialDiffStyled(patch, options)
  return result === undefined ? undefined : toOpenText(result)
}
export const renderPierreDiff = (patch: string, options: DiffRenderOptions): StyledText | undefined => {
  const result = pierreDiff(options)(patch)
  return result === undefined ? undefined : toOpenText(result)
}
export const renderToolSummary = (
  summary: Parameters<typeof toolSummary>[0],
  options?: Parameters<typeof toolSummary>[1],
): ReadonlyArray<ReadonlyArray<TextChunk>> =>
  toolSummary(summary, options).map((line) => line.map((chunk) => ({ ...chunk, __isChunk: true }) as TextChunk))
