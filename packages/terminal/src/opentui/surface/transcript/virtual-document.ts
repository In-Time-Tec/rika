import type { Model } from "../../../state/model"
import {
  itemPositionAtVirtualRow,
  transcriptVirtualIndex,
  virtualRowOfItemPosition,
  type TranscriptVirtualIndex,
} from "../../../presentation/transcript/viewport/virtual-index"
import { maxMountedTranscriptEntries } from "../../rendering/transcript/window"

interface TranscriptVirtualMetricsInput {
  readonly model: Model | undefined
  readonly windowEnd: number
  readonly bandRowsBefore: number
  readonly bandRowsAfter: number
  readonly physicalScrollHeight: number
}

export class TranscriptVirtualDocument {
  private items: unknown
  private entries: unknown
  private blocks: unknown
  private expandedRowKeys: unknown
  private width = 0
  private indexValue: TranscriptVirtualIndex | undefined

  itemAtRow(model: Model, row: number): number {
    return itemPositionAtVirtualRow(this.index(model), row)
  }

  metrics(input: TranscriptVirtualMetricsInput): { readonly scrollHeight: number; readonly rowsAbove: number } {
    const { model } = input
    if (model === undefined) return { scrollHeight: input.physicalScrollHeight, rowsAbove: 0 }
    if (
      model.items.length === 0 ||
      (model.items.length <= maxMountedTranscriptEntries && input.bandRowsBefore === 0 && input.bandRowsAfter === 0)
    )
      return { scrollHeight: input.physicalScrollHeight, rowsAbove: 0 }
    const index = this.index(model)
    const windowStartItem = Math.max(0, input.windowEnd - maxMountedTranscriptEntries)
    const estimatedStart = virtualRowOfItemPosition(index, windowStartItem)
    const estimatedEnd = virtualRowOfItemPosition(index, input.windowEnd)
    const estimatedWindowRows = Math.max(0, estimatedEnd - estimatedStart)
    return {
      scrollHeight: Math.max(0, index.totalRows - estimatedWindowRows + input.physicalScrollHeight),
      rowsAbove: estimatedStart,
    }
  }

  private index(model: Model): TranscriptVirtualIndex {
    if (
      this.items !== model.items ||
      this.entries !== model.entries ||
      this.blocks !== model.blocks ||
      this.expandedRowKeys !== model.expandedRowKeys ||
      this.width !== model.width
    ) {
      this.items = model.items
      this.entries = model.entries
      this.blocks = model.blocks
      this.expandedRowKeys = model.expandedRowKeys
      this.width = model.width
      this.indexValue = transcriptVirtualIndex(model, model.width)
    }
    return this.indexValue!
  }
}
