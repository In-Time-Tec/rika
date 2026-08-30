import { Function, Schema } from "effect"
import { cellBodyText } from "@rika/transcript/cell-presentation"
import type { Model } from "../../../state/model"
import { TranscriptBlock, type TranscriptItem } from "../../../state/transcript/model"
import { spacing } from "../../terminal/theme"
import { orderedTranscriptItems } from "../row"
import { toolResultText } from "../tool/body"

export const transcriptWrapWidth = (width: number): number => Math.max(8, width - spacing.transcript * 2 - 2)

export interface TranscriptVirtualIndex {
  readonly rowsPerItem: Float64Array
  readonly prefix: Float64Array
  readonly totalRows: number
}

const textRows = (text: string, wrapWidth: number): number =>
  Math.max(1, Math.ceil(text.length / Math.max(1, wrapWidth)))

const blockText = (block: TranscriptBlock | undefined): string => {
  switch (block?._tag) {
    case "ToolCall":
      return [block.detail, toolResultText(block.result) ?? "", ...block.files.map((file) => file.path)].join("\n")
    case "ToolResult":
      return block.output
    case "Diff":
      return block.patch
    case "Reasoning":
      return block.text
    case "SubagentCard":
      return [block.summary, ...block.activity].join("\n")
    case "Error":
      return block.detail
    case "Notification":
      return [block.title, block.detail].join("\n")
    case "AuthorizationCard":
      return block.input
    case "Compaction":
      return block.summary
    case "ContextUsage":
      return block.text
    case "Cell":
      return [cellBodyText(block), ...block.files.map((file) => file.path)].join("\n")
    default:
      return ""
  }
}

const itemRows = (item: TranscriptItem, model: Model, wrapWidth: number): number => {
  if (item._tag === "Entry") return textRows(model.entries[item.index]?.text ?? "", wrapWidth)
  return 1 + textRows(blockText(Schema.decodeUnknownSync(TranscriptBlock)(model.blocks[item.index])), wrapWidth)
}

export const transcriptVirtualIndex: {
  (width: number): (model: Model) => TranscriptVirtualIndex
  (model: Model, width: number): TranscriptVirtualIndex
} = Function.dual(2, (model: Model, width: number): TranscriptVirtualIndex => {
  const wrapWidth = transcriptWrapWidth(width)
  const items = orderedTranscriptItems(model)
  const rowsPerItem = new Float64Array(items.length)
  const prefix = new Float64Array(items.length + 1)
  for (let position = 0; position < items.length; position += 1) {
    const rows = itemRows(items[position]!, model, wrapWidth)
    rowsPerItem[position] = rows
    prefix[position + 1] = prefix[position]! + rows + (position + 1 < items.length ? 1 : 0)
  }
  return { rowsPerItem, prefix, totalRows: prefix[items.length]! }
})

export const itemPositionAtVirtualRow: {
  (row: number): (index: TranscriptVirtualIndex) => number
  (index: TranscriptVirtualIndex, row: number): number
} = Function.dual(2, (index: TranscriptVirtualIndex, row: number): number => {
  const clamped = Math.max(0, Math.min(row, index.totalRows))
  let low = 0
  let high = index.prefix.length - 1
  while (low < high) {
    const mid = (low + high) >> 1
    if (index.prefix[mid]! <= clamped) low = mid + 1
    else high = mid
  }
  return Math.max(0, low - 1)
})

export const virtualRowOfItemPosition: {
  (position: number): (index: TranscriptVirtualIndex) => number
  (index: TranscriptVirtualIndex, position: number): number
} = Function.dual(
  2,
  (index: TranscriptVirtualIndex, position: number): number =>
    index.prefix[Math.max(0, Math.min(position, index.prefix.length - 1))]!,
)
