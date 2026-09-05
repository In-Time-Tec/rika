import { expect, test } from "vitest"
import { initial, type Model } from "../../../../src/state/model"
import {
  transcriptVirtualIndex,
  itemPositionAtVirtualRow,
  virtualRowOfItemPosition,
} from "../../../../src/presentation/transcript/viewport/virtual-index"

const entryModel = (count: number, text: (index: number) => string): Model => {
  const entries = Array.from({ length: count }, (_, index) => ({
    role: "assistant" as const,
    text: text(index),
    turnId: `turn-${index}`,
  }))
  return {
    ...initial("/work", "medium"),
    entries,
    items: entries.map((_, index) => ({
      _tag: "Entry" as const,
      index,
      id: `entry-${index}`,
      turnId: `turn-${index}`,
    })),
  }
}

test("transcriptVirtualIndex estimates rows and maps rows to item positions", () => {
  const model = entryModel(6, (index) => "x".repeat(20 * (index + 1)))
  const index = transcriptVirtualIndex(model, 40)
  expect(index.rowsPerItem).toHaveLength(6)
  expect(index.totalRows).toBeGreaterThan(0)
  for (let position = 0; position < 6; position += 1) {
    expect(virtualRowOfItemPosition(index, position)).toBe(index.prefix[position])
    const start = index.prefix[position]!
    const end = index.prefix[position + 1]!
    expect(itemPositionAtVirtualRow(index, start)).toBe(position)
    expect(itemPositionAtVirtualRow(index, Math.max(0, end - 1))).toBe(position)
  }
  expect(itemPositionAtVirtualRow(index, index.totalRows + 100)).toBe(5)
  expect(itemPositionAtVirtualRow(index, -5)).toBe(0)
})

test("transcriptVirtualIndex handles an empty timeline", () => {
  const index = transcriptVirtualIndex(initial("/work", "medium"), 80)
  expect(index.totalRows).toBe(0)
  expect(itemPositionAtVirtualRow(index, 0)).toBe(0)
  expect(virtualRowOfItemPosition(index, 0)).toBe(0)
})
