import stringWidth from "string-width"
import { Function } from "effect"
import { truncateToWidth } from "../terminal/terminal-format"

export interface FittedHints {
  readonly labels: ReadonlyArray<string>
  readonly truncated: boolean
}

const hintWidth = (label: string): number => stringWidth(label.replaceAll("↔", "x"))

const fitOverlayHintsImpl = (labels: ReadonlyArray<string>, available: number): FittedHints => {
  const fitted: Array<string> = []
  let used = 0
  let truncated = false
  for (const label of labels) {
    const separator = fitted.length === 0 ? 0 : 2
    const remaining = available - used - separator
    if (remaining <= 0) break
    const width = hintWidth(label)
    let value = label
    if (width > remaining) value = remaining === 1 ? "…" : `${truncateToWidth(label, remaining - 1)}…`
    fitted.push(value)
    used += separator + hintWidth(value)
    if (width > remaining) {
      truncated = true
      break
    }
  }
  return { labels: fitted, truncated: truncated || fitted.length < labels.length }
}

export const fitOverlayHints: {
  (labels: ReadonlyArray<string>, available: number): FittedHints
  (available: number): (labels: ReadonlyArray<string>) => FittedHints
} = Function.dual(2, fitOverlayHintsImpl)

export const overlayHintWidth = hintWidth
