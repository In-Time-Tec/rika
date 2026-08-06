import { expect, test } from "vitest"
import { welcomeContent } from "../src/opentui/surface/opentui-surface-content"
import { ampOrbFrames } from "../src/opentui/surface/opentui-amp-orb-frames"

const rowsOf = (width: number, height: number, phase: number) =>
  welcomeContent(width, height, phase, "medium")
    .chunks.map((chunk) => chunk.text)
    .join("")
    .split("\n")

const copyRow = (width: number, height: number, phase: number, copy: string) =>
  rowsOf(width, height, phase).findIndex((row) => row.includes(copy))

const copyColumn = (width: number, height: number, phase: number, copy: string) => {
  const row = rowsOf(width, height, phase).find((line) => line.includes(copy))
  return row === undefined ? -1 : row.indexOf(copy)
}

test.each([["Welcome to Rika"], ["ctrl+o"], ["?"]])(
  "anchors the large welcome copy %s to a fixed row across every orb phase",
  (copy) => {
    const rows = ampOrbFrames.large.map((_, phase) => copyRow(160, 44, phase, copy))
    expect(rows).not.toContain(-1)
    expect(new Set(rows).size).toBe(1)
  },
)

test.each([["Welcome to Rika"], ["ctrl+o"], ["?"]])(
  "anchors the small welcome copy %s to a fixed row across every orb phase",
  (copy) => {
    const rows = ampOrbFrames.small.map((_, phase) => copyRow(120, 30, phase, copy))
    expect(rows).not.toContain(-1)
    expect(new Set(rows).size).toBe(1)
  },
)

test("anchors the welcome copy to a fixed column across every orb phase", () => {
  const large = ampOrbFrames.large.map((_, phase) => copyColumn(160, 44, phase, "Welcome to Rika"))
  const small = ampOrbFrames.small.map((_, phase) => copyColumn(120, 30, phase, "Welcome to Rika"))
  expect(new Set(large).size).toBe(1)
  expect(new Set(small).size).toBe(1)
})

test("renders a constant welcome row count across every orb phase", () => {
  const large = ampOrbFrames.large.map((_, phase) => rowsOf(160, 44, phase).length)
  const small = ampOrbFrames.small.map((_, phase) => rowsOf(120, 30, phase).length)
  expect(new Set(large).size).toBe(1)
  expect(new Set(small).size).toBe(1)
})
