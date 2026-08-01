import stringWidth from "string-width"
import { idleSpinnerFrame } from "./opentui-spinner"

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })
export const wrapTextToWidth = (text: string, width: number): ReadonlyArray<string> => {
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
export const wrapBodyText = (text: string, width: number, indent: string): string =>
  wrapTextToWidth(text, Math.max(1, width - stringWidth(indent)))
    .map((line) => `${indent}${line}`)
    .join("\n")
export const iconChar = (failed: boolean, running: boolean, frame = idleSpinnerFrame, cancelled = false): string => {
  if (running) return frame
  if (cancelled) return "⊘"
  return failed ? "✕" : "✓"
}

export const markerText = (expanded: boolean): string => (expanded ? " ▾" : " ▸")

export const cancelledAgentLabel = (activeLabel: string): string =>
  `${activeLabel.split(" ")[0] ?? "Subagent"} cancelled`
export const failedAgentLabel = (activeLabel: string): string => `${activeLabel.split(" ")[0] ?? "Subagent"} failed`
