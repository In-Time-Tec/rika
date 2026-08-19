import type { ModeId } from "@rika/configuration/behavior-mode"
import { Function } from "effect"
import stringWidth from "string-width"

export interface ModeSelectorLabel {
  readonly index: number
  readonly mode: ModeId
  readonly text: string
  readonly start: number
  readonly end: number
}

const minimumSeparatedWidth = (labels: ReadonlyArray<string>): number =>
  labels.reduce((total, label) => total + stringWidth(label), 0) + labels.length - 1

const labelStarts = (width: number, widths: ReadonlyArray<number>): ReadonlyArray<number> => {
  if (widths.length === 0) return []
  const gapColumns = width - widths.reduce((total, labelWidth) => total + labelWidth, 0)
  if (widths.length === 1) return [Math.max(0, Math.floor((width - widths[0]!) / 2))]
  let cursor = 0
  return widths.map((labelWidth, index) => {
    const start = cursor + Math.ceil((Math.max(0, gapColumns) * index) / (widths.length - 1))
    cursor += labelWidth
    return start
  })
}

const modeSelectorLabelsImpl = (innerWidth: number, modes: ReadonlyArray<ModeId>): ReadonlyArray<ModeSelectorLabel> => {
  const width = Math.max(0, Math.floor(innerWidth))
  const fullLabels = [...modes]
  const abbreviatedLabels = modes.map((mode) => (mode.length <= 5 ? mode : mode.slice(0, 3)))
  const initialLabels = modes.map((mode) => mode.slice(0, 1))
  let labels: ReadonlyArray<string>
  if (width >= minimumSeparatedWidth(fullLabels)) labels = fullLabels
  else if (width >= minimumSeparatedWidth(abbreviatedLabels)) labels = abbreviatedLabels
  else if (width >= initialLabels.length) labels = initialLabels
  else labels = initialLabels.map((label, index) => (index < width ? label : ""))
  const widths = labels.map((label) => stringWidth(label))
  const starts = labelStarts(width, widths)
  return modes.map((mode, index) => ({
    index,
    mode,
    text: labels[index]!,
    start: starts[index]!,
    end: starts[index]! + widths[index]!,
  }))
}

export const modeSelectorLabels: {
  (modes: ReadonlyArray<ModeId>): (innerWidth: number) => ReadonlyArray<ModeSelectorLabel>
  (innerWidth: number, modes: ReadonlyArray<ModeId>): ReadonlyArray<ModeSelectorLabel>
} = Function.dual(2, modeSelectorLabelsImpl)

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
