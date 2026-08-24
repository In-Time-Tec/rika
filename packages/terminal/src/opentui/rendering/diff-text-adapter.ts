import { Function } from "effect"
import { StyledText, type TextChunk } from "@opentui/core"
import { toOpenColor } from "./text-adapter"
import type { TerminalStyledText, TerminalTextChunk } from "../../presentation/markdown/styled-text"
import {
  renderDiffStyled as diffStyled,
  renderPartialDiffStyled as partialDiffStyled,
} from "../../presentation/tool/diff-renderer"
import { renderPierreDiff as pierreDiff, type DiffRenderOptions } from "../../presentation/tool/pierre-diff-adapter"
import { renderToolSummary as toolSummary } from "../../presentation/tool/summary"
const toOpenChunk = (chunk: TerminalTextChunk): TextChunk => {
  const result: TextChunk = { __isChunk: true, text: chunk.text }
  if (chunk.fg !== undefined) result.fg = toOpenColor(chunk.fg)
  if (chunk.bg !== undefined) result.bg = toOpenColor(chunk.bg)
  if (chunk.attributes !== undefined) result.attributes = chunk.attributes
  if (chunk.link !== undefined) result.link = chunk.link
  return result
}
const toOpenText = (text: TerminalStyledText): StyledText => new StyledText(text.chunks.map(toOpenChunk))

const renderDiffStyledImpl = (patch: string, options: Parameters<typeof diffStyled>[1]): StyledText =>
  toOpenText(diffStyled(patch, options))

export const renderDiffStyled: {
  (
    arg1: Parameters<typeof renderDiffStyledImpl>[1],
  ): (arg0: Parameters<typeof renderDiffStyledImpl>[0]) => ReturnType<typeof renderDiffStyledImpl>
  (
    arg0: Parameters<typeof renderDiffStyledImpl>[0],
    arg1: Parameters<typeof renderDiffStyledImpl>[1],
  ): ReturnType<typeof renderDiffStyledImpl>
} = Function.dual(2, renderDiffStyledImpl)
const renderPartialDiffStyledImpl = (
  patch: string,
  options: Parameters<typeof partialDiffStyled>[1],
): StyledText | undefined => {
  const result = partialDiffStyled(patch, options)
  return result === undefined ? undefined : toOpenText(result)
}

export const renderPartialDiffStyled: {
  (
    arg1: Parameters<typeof renderPartialDiffStyledImpl>[1],
  ): (arg0: Parameters<typeof renderPartialDiffStyledImpl>[0]) => ReturnType<typeof renderPartialDiffStyledImpl>
  (
    arg0: Parameters<typeof renderPartialDiffStyledImpl>[0],
    arg1: Parameters<typeof renderPartialDiffStyledImpl>[1],
  ): ReturnType<typeof renderPartialDiffStyledImpl>
} = Function.dual(2, renderPartialDiffStyledImpl)
const renderPierreDiffImpl = (patch: string, options: DiffRenderOptions): StyledText | undefined => {
  const result = pierreDiff(options)(patch)
  return result === undefined ? undefined : toOpenText(result)
}

export const renderPierreDiff: {
  (
    arg1: Parameters<typeof renderPierreDiffImpl>[1],
  ): (arg0: Parameters<typeof renderPierreDiffImpl>[0]) => ReturnType<typeof renderPierreDiffImpl>
  (
    arg0: Parameters<typeof renderPierreDiffImpl>[0],
    arg1: Parameters<typeof renderPierreDiffImpl>[1],
  ): ReturnType<typeof renderPierreDiffImpl>
} = Function.dual(2, renderPierreDiffImpl)
const renderToolSummaryImpl = (
  summary: Parameters<typeof toolSummary>[0],
  options?: Parameters<typeof toolSummary>[1],
): ReadonlyArray<ReadonlyArray<TextChunk>> =>
  toolSummary(summary, options).map((line) => line.map(toOpenChunk))

export const renderToolSummary: {
  (
    arg0: Parameters<typeof renderToolSummaryImpl>[0],
    arg1?: Parameters<typeof renderToolSummaryImpl>[1],
  ): ReturnType<typeof renderToolSummaryImpl>
  (
    arg1?: Parameters<typeof renderToolSummaryImpl>[1],
  ): (arg0: Parameters<typeof renderToolSummaryImpl>[0]) => ReturnType<typeof renderToolSummaryImpl>
} = Function.dual((args) => args.length > 0, renderToolSummaryImpl)
