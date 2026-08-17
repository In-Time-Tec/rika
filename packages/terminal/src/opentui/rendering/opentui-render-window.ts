import { Function } from "effect"
import type { TextChunk } from "@opentui/core"
import stringWidth from "string-width"
import { restingFrame } from "./opentui-animation-frame"

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })
const wrapTextToWidthImpl = (text: string, width: number): ReadonlyArray<string> => {
  const lines: Array<string> = []
  for (const hardLine of text.split("\n")) {
    let rest = hardLine
    while (stringWidth(rest) > width) {
      let end = 0
      let breakAt = 0
      let used = 0
      for (const { segment, index } of graphemeSegmenter.segment(rest)) {
        const cells = stringWidth(segment)
        if (used + cells > width) break
        used += cells
        end = index + segment.length
        if (/\s/u.test(segment)) breakAt = end
      }
      let split = breakAt === 0 ? end : breakAt
      if (split === 0) split = rest.slice(0, 1).length
      lines.push(rest.slice(0, split).trimEnd())
      rest = rest.slice(split).trimStart()
    }
    lines.push(rest)
  }
  return lines
}

export const wrapTextToWidth: {
  (
    arg1: Parameters<typeof wrapTextToWidthImpl>[1],
  ): (arg0: Parameters<typeof wrapTextToWidthImpl>[0]) => ReturnType<typeof wrapTextToWidthImpl>
  (
    arg0: Parameters<typeof wrapTextToWidthImpl>[0],
    arg1: Parameters<typeof wrapTextToWidthImpl>[1],
  ): ReturnType<typeof wrapTextToWidthImpl>
} = Function.dual(2, wrapTextToWidthImpl)
const wrapBodyTextImpl = (text: string, width: number, indent: string): string =>
  wrapTextToWidth(text, Math.max(1, width - stringWidth(indent)))
    .map((line) => `${indent}${line}`)
    .join("\n")

export const wrapBodyText: {
  (
    arg1: Parameters<typeof wrapBodyTextImpl>[1],
    arg2: Parameters<typeof wrapBodyTextImpl>[2],
  ): (arg0: Parameters<typeof wrapBodyTextImpl>[0]) => ReturnType<typeof wrapBodyTextImpl>
  (
    arg0: Parameters<typeof wrapBodyTextImpl>[0],
    arg1: Parameters<typeof wrapBodyTextImpl>[1],
    arg2: Parameters<typeof wrapBodyTextImpl>[2],
  ): ReturnType<typeof wrapBodyTextImpl>
} = Function.dual(3, wrapBodyTextImpl)
const iconCharImpl = (failed: boolean, running: boolean, frame = restingFrame, cancelled = false): string => {
  if (running) return frame
  if (cancelled) return "⊘"
  return failed ? "✕" : "✓"
}

export const iconChar: {
  (
    arg0: Parameters<typeof iconCharImpl>[0],
    arg1: Parameters<typeof iconCharImpl>[1],
    arg2?: Parameters<typeof iconCharImpl>[2],
    arg3?: Parameters<typeof iconCharImpl>[3],
  ): ReturnType<typeof iconCharImpl>
  (
    arg1: Parameters<typeof iconCharImpl>[1],
    arg2?: Parameters<typeof iconCharImpl>[2],
    arg3?: Parameters<typeof iconCharImpl>[3],
  ): (arg0: Parameters<typeof iconCharImpl>[0]) => ReturnType<typeof iconCharImpl>
} = Function.dual((args) => args.length >= 2 && typeof args[1] === "boolean", iconCharImpl)

/**
 * Marks a chunk as the animated glyph of its row. The repaint pass rewrites marked chunks in place
 * instead of searching rendered text for a character, so a row animates because it was built to,
 * not because its icon happened to match the frame the search was looking for.
 */
const animationMark = Symbol.for("rika.animatedChunk")

interface MarkedChunk extends TextChunk {
  readonly [animationMark]?: true
}

export const animatedChunk = (chunk: TextChunk): TextChunk => {
  const marked: MarkedChunk = { ...chunk, [animationMark]: true }
  return marked
}

export const isAnimatedChunk = (chunk: TextChunk): boolean => (chunk as MarkedChunk)[animationMark] === true

export const markerText = (expanded: boolean): string => (expanded ? " ▾" : " ▸")

export { subagentPhrase } from "@rika/transcript/subagent-presentation"

export const cancelledAgentLabel = (activeLabel: string): string =>
  `${activeLabel.split(" ")[0] ?? "Subagent"} cancelled`
export const failedAgentLabel = (activeLabel: string): string => `${activeLabel.split(" ")[0] ?? "Subagent"} failed`
