import { expect, test } from "vitest"
import {
  modeSelectorIndexAtColumn,
  modeSelectorLabels,
  modeSelectorNotchAtPosition,
} from "../src/presentation/terminal/terminal-mode-selector-layout"

test("lays out four non-overlapping mode labels across compact content widths 20 through 28", () => {
  for (let width = 20; width <= 28; width += 1) {
    const labels = modeSelectorLabels(width)
    expect(labels).toHaveLength(4)
    expect(labels.map((label) => label.mode)).toEqual(["low", "medium", "high", "ultra"])
    expect(labels[0]!.start).toBe(0)
    expect(labels.at(-1)!.end).toBe(width)
    for (const [index, label] of labels.entries()) {
      expect(label.end).toBeLessThanOrEqual(width)
      expect(modeSelectorNotchAtPosition(labels, index)).toBe(label.start)
      for (let column = label.start; column < label.end; column += 1) {
        expect(modeSelectorIndexAtColumn(labels, column)).toBe(index)
      }
      const next = labels[index + 1]
      if (next === undefined) continue
      expect(next.start - label.end).toBeGreaterThanOrEqual(1)
      for (let column = label.end; column < next.start; column += 1) {
        expect(modeSelectorIndexAtColumn(labels, column)).toBeUndefined()
      }
    }
  }
})

test("abbreviates only the mathematically constrained 20-column medium label", () => {
  expect(modeSelectorLabels(20)).toEqual([
    { index: 0, mode: "low", text: "low", start: 0, end: 3 },
    { index: 1, mode: "medium", text: "med", start: 5, end: 8 },
    { index: 2, mode: "high", text: "high", start: 10, end: 14 },
    { index: 3, mode: "ultra", text: "ultra", start: 15, end: 20 },
  ])
  expect(modeSelectorLabels(21).map((label) => label.text)).toEqual(["low", "medium", "high", "ultra"])
})
