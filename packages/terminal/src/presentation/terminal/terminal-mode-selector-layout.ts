import { modeIds, type ModeId } from "@rika/config/behavior-mode"
import { Function } from "effect"
import stringWidth from "string-width"

export interface ModeSelectorLabel {
  readonly index: number
  readonly mode: ModeId
  readonly text: string
  readonly start: number
  readonly end: number
}

const compactLabels: Readonly<Record<ModeId, string>> = {
  low: "low",
  medium: "med",
  high: "high",
  ultra: "ultra",
}

const minimumSeparatedWidth = (labels: ReadonlyArray<string>): number =>
  labels.reduce((total, label) => total + stringWidth(label), 0) + labels.length - 1

const labelStarts = (width: number, widths: ReadonlyArray<number>): ReadonlyArray<number> => {
  const gapColumns = width - widths.reduce((total, labelWidth) => total + labelWidth, 0)
  const minimumGap = gapColumns >= widths.length - 1 ? 1 : 0
  const lastStart = Math.max(0, width - (widths.at(-1) ?? 0))
  const ideal = widths.map((_, index) => Math.floor((index * lastStart) / Math.max(1, widths.length - 1)))
  let bestStarts: ReadonlyArray<number> = ideal
  let bestScore = Number.POSITIVE_INFINITY
  for (let firstGap = minimumGap; firstGap <= gapColumns - minimumGap * 2; firstGap += 1) {
    for (let secondGap = minimumGap; secondGap <= gapColumns - firstGap - minimumGap; secondGap += 1) {
      const thirdGap = gapColumns - firstGap - secondGap
      if (thirdGap < minimumGap) continue
      const starts = [0, widths[0]! + firstGap, widths[0]! + firstGap + widths[1]! + secondGap, lastStart]
      const score = starts.reduce((total, start, index) => total + (start - ideal[index]!) ** 2, 0)
      if (score < bestScore) {
        bestStarts = starts
        bestScore = score
      }
    }
  }
  return bestStarts
}

export const modeSelectorLabels = (innerWidth: number): ReadonlyArray<ModeSelectorLabel> => {
  const width = Math.max(0, Math.floor(innerWidth))
  const fullLabels = [...modeIds]
  const abbreviatedLabels = modeIds.map((mode) => compactLabels[mode])
  const initialLabels = modeIds.map((mode) => mode.slice(0, 1))
  let labels: ReadonlyArray<string>
  if (width >= minimumSeparatedWidth(fullLabels)) labels = fullLabels
  else if (width >= minimumSeparatedWidth(abbreviatedLabels)) labels = abbreviatedLabels
  else if (width >= initialLabels.length) labels = initialLabels
  else labels = initialLabels.map((label, index) => (index < width ? label : ""))
  const widths = labels.map((label) => stringWidth(label))
  const starts = labelStarts(width, widths)
  return modeIds.map((mode, index) => ({
    index,
    mode,
    text: labels[index]!,
    start: starts[index]!,
    end: starts[index]! + widths[index]!,
  }))
}

const modeSelectorIndexAtColumnImpl = (labels: ReadonlyArray<ModeSelectorLabel>, column: number): number | undefined =>
  labels.find((label) => column >= label.start && column < label.end)?.index

export const modeSelectorIndexAtColumn: {
  (column: number): (labels: ReadonlyArray<ModeSelectorLabel>) => number | undefined
  (labels: ReadonlyArray<ModeSelectorLabel>, column: number): number | undefined
} = Function.dual(2, modeSelectorIndexAtColumnImpl)

const modeSelectorNotchAtPositionImpl = (labels: ReadonlyArray<ModeSelectorLabel>, position: number): number => {
  const bounded = Math.max(0, Math.min(labels.length - 1, position))
  const before = labels[Math.floor(bounded)]
  const after = labels[Math.ceil(bounded)]
  if (before === undefined || after === undefined) return 0
  return Math.round(before.start + (after.start - before.start) * (bounded - Math.floor(bounded)))
}

export const modeSelectorNotchAtPosition: {
  (position: number): (labels: ReadonlyArray<ModeSelectorLabel>) => number
  (labels: ReadonlyArray<ModeSelectorLabel>, position: number): number
} = Function.dual(2, modeSelectorNotchAtPositionImpl)
