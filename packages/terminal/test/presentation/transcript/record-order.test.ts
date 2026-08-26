import { describe, expect, test } from "vitest"
import { mergePinnedRecords } from "../../../src/presentation/transcript/record-order"

const record = (key: string) => ({ key, renderable: { id: key } })

describe("selection-pinned record ordering", () => {
  test("keeps a pinned survivor in its prior relative position, not at the top", () => {
    const a = record("a")
    const b = record("b")
    const c = record("c")
    const previous = new Map([
      [a.renderable, 0],
      [b.renderable, 1],
      [c.renderable, 2],
    ])
    const merged = mergePinnedRecords([a, c], [b], previous)
    expect(merged.map((entry) => entry.key)).toEqual(["a", "b", "c"])
  })

  test("appends a pinned record that used to be last", () => {
    const a = record("a")
    const b = record("b")
    const previous = new Map([
      [a.renderable, 0],
      [b.renderable, 5],
    ])
    expect(mergePinnedRecords([a], [b], previous).map((entry) => entry.key)).toEqual(["a", "b"])
  })

  test("places an unknown pinned record first, since it has no prior position", () => {
    const a = record("a")
    const orphan = record("orphan")
    const previous = new Map([[a.renderable, 3]])
    expect(mergePinnedRecords([a], [orphan], previous).map((entry) => entry.key)).toEqual(["orphan", "a"])
  })

  test("is an identity when nothing is pinned", () => {
    const a = record("a")
    const b = record("b")
    expect(mergePinnedRecords([a, b], [], new Map()).map((entry) => entry.key)).toEqual(["a", "b"])
  })
})
