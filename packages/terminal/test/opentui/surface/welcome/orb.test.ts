import { expect, test } from "vitest"
import { welcomeContent } from "../../../../src/opentui/surface/content"
import { orbGeometry, orbRows, orbImpulseExpired, type OrbImpulse } from "../../../../src/opentui/surface/welcome/orb"

const phases = Array.from({ length: 24 }, (_, phase) => phase * 3)

const rowsOf = (width: number, height: number, phase: number, impulses: ReadonlyArray<OrbImpulse> = []) =>
  welcomeContent(width, height, phase, "medium", impulses)
    .chunks.map((chunk) => chunk.text)
    .join("")
    .split("\n")

const copyRow = (width: number, height: number, phase: number, copy: string) =>
  rowsOf(width, height, phase).findIndex((row) => row.includes(copy))

test.each([["Welcome to Rika"], ["ctrl+o"], ["?"]])(
  "anchors the welcome copy %s to a fixed row across every phase",
  (copy) => {
    const rows = phases.map((phase) => copyRow(160, 44, phase, copy))
    expect(rows).not.toContain(-1)
    expect(new Set(rows).size).toBe(1)
  },
)

test("renders a constant row count across every phase", () => {
  const large = phases.map((phase) => rowsOf(160, 44, phase).length)
  const small = phases.map((phase) => rowsOf(120, 30, phase).length)
  expect(new Set(large).size).toBe(1)
  expect(new Set(small).size).toBe(1)
})

test("reuses a precomputed idle frame after one animation cycle", () => {
  const geometry = orbGeometry(160, 44)
  expect(orbRows(geometry, 7, [])).toBe(orbRows(geometry, 127, []))
})

test("keeps the orb bounding box fixed while an impulse expands", () => {
  const geometry = orbGeometry(160, 44)
  const impulse: OrbImpulse = { column: 10, row: 4, startPhase: 0 }
  const extents = phases.map((phase) => {
    const rows = orbRows(geometry, phase, [impulse])
    const filled = rows.flatMap((row, index) => (row.trim().length > 0 ? [index] : []))
    return `${rows.length}:${Math.min(...filled)}:${Math.max(...filled)}`
  })
  expect(new Set(extents).size).toBe(1)
})

const brightness = (rows: ReadonlyArray<string>) => rows.join("").split("●").length - 1

test("brightens cells near the impulse origin when it fires", () => {
  const geometry = orbGeometry(160, 44)
  const origin = { column: Math.floor(geometry.columns / 2), row: Math.floor(geometry.rows / 2) }
  const idle = orbRows(geometry, 0, [])
  const struck = orbRows(geometry, 0, [{ ...origin, startPhase: 0 }])
  expect(brightness(struck)).toBeGreaterThan(brightness(idle))
})

test("reacts at the clicked position rather than a fixed point", () => {
  const geometry = orbGeometry(160, 44)
  const left = orbRows(geometry, 2, [{ column: 6, row: 5, startPhase: 0 }]).join("\n")
  const right = orbRows(geometry, 2, [{ column: geometry.columns - 7, row: 5, startPhase: 0 }]).join("\n")
  expect(left).not.toEqual(right)
})

test("expires an impulse once its wave has decayed", () => {
  const impulse: OrbImpulse = { column: 4, row: 4, startPhase: 0 }
  expect(orbImpulseExpired(impulse, 5)).toBe(false)
  expect(orbImpulseExpired(impulse, 400)).toBe(true)
})
