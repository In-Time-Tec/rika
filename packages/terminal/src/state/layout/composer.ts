import stringWidth from "string-width"
import { Function } from "effect"
import type { Model } from "../model"
import { readyOr } from "../loadable"
import { displayInput } from "../composer/model"
import { contentColumnWidth } from "./model"

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })
const wrappedRowsForLine = (text: string, width: number): number => {
  if (width <= 0) return 1
  let rows = 1
  let column = 0
  for (const { segment } of graphemeSegmenter.segment(text)) {
    const cells = stringWidth(segment)
    if (cells === 0) continue
    if (column + cells > width) {
      rows += 1
      column = cells
    } else column += cells
  }
  return rows
}
export const wrappedRowCount: {
  (text: string, width: number): number
  (width: number): (text: string) => number
} = Function.dual(2, (text: string, width: number): number =>
  text.split("\n").reduce((rows, line) => rows + wrappedRowsForLine(line, width), 0),
)
export const queueContentWidth = (model: Model): number => Math.max(1, contentColumnWidth(model) - 6)
export const inputRows = (model: Model): number =>
  Math.min(8, Math.max(1, wrappedRowCount(displayInput(model), Math.max(1, contentColumnWidth(model) - 4))))
export const composerHeight = (model: Model): number =>
  Math.min(composerHeightLimit(model.height), Math.max(5, model.composerHeight, inputRows(model) + 2))
export const composerHeightLimit = (terminalHeight: number): number =>
  Math.max(1, Math.min(5, terminalHeight), terminalHeight - 4)
export const readyFiles = (model: Model): ReadonlyArray<string> => {
  const items = readyOr(model.filePicker.items, [])
  const query = model.filePicker.query.toLowerCase()
  if (query.length === 0) {
    const segments = new Set<string>()
    for (const file of items) segments.add(file.split("/")[0]!)
    return [...segments].toSorted().slice(0, 50)
  }
  return items.filter((file) => file.toLowerCase().includes(query)).slice(0, 50)
}
