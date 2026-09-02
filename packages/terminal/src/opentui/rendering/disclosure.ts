import { dim, fg, type TextChunk } from "@opentui/core"
import { colors } from "../../presentation/terminal/theme"

/** The expand or collapse marker shown at the right end of an expandable row header. */
const disclosureChunk = (expanded: boolean, selected = false): TextChunk =>
  dim(fg(selected ? colors.blue : colors.subtle)(expanded ? " ▾" : " ▸"))

/**
 * Places `marker` at the end of the first rendered line at or after `from`.
 * Rows render their header first, so this puts the marker after the header text
 * without changing the line count of anything rendered after it.
 */
const insertTrailingMarker = (chunks: Array<TextChunk>, from: number, marker: TextChunk): void => {
  for (let index = from; index < chunks.length; index += 1) {
    const current = chunks[index]!
    const newline = current.text.indexOf("\n")
    if (newline === -1) continue
    const head = current.text.slice(0, newline)
    const replacement = head.length > 0 ? [{ ...current, text: head }, marker] : [marker]
    chunks.splice(index, 1, ...replacement, { ...current, text: current.text.slice(newline) })
    return
  }
  chunks.push(marker)
}

export const disclosure = { chunk: disclosureChunk, insertTrailingMarker }
