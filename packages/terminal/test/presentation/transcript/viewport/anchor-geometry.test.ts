import { describe, expect, test } from "vitest"
import { topmostVisibleAnchor } from "../../../../src/presentation/transcript/viewport/anchor-geometry"

const candidate = (key: string, screenY: number, height = 3) => ({ key, screenY, height })

describe("topmost visible anchor", () => {
  test("selects the first row whose bottom edge is inside the viewport", () => {
    const anchor = topmostVisibleAnchor([candidate("a", 0), candidate("b", 10), candidate("c", 20)], {
      viewportTop: 12,
      drift: 0,
    })
    expect(anchor).toEqual({ key: "b", screenY: 10 })
  })

  test("ignores zero-height rows, which have not been laid out yet", () => {
    const anchor = topmostVisibleAnchor([candidate("unlaid", 5, 0), candidate("real", 8)], {
      viewportTop: 0,
      drift: 0,
    })
    expect(anchor?.key).toBe("real")
  })

  test("applies scroll drift so an anchor captured mid-gesture stays correct", () => {
    const anchor = topmostVisibleAnchor([candidate("a", 0), candidate("b", 10)], { viewportTop: 12, drift: 5 })
    expect(anchor).toEqual({ key: "b", screenY: 15 })
  })

  test("returns undefined when nothing is visible", () => {
    expect(topmostVisibleAnchor([candidate("a", 0)], { viewportTop: 100, drift: 0 })).toBeUndefined()
    expect(topmostVisibleAnchor([], { viewportTop: 0, drift: 0 })).toBeUndefined()
  })

  test("orders by screen position, not insertion order", () => {
    const anchor = topmostVisibleAnchor([candidate("late", 40), candidate("early", 10)], {
      viewportTop: 0,
      drift: 0,
    })
    expect(anchor?.key).toBe("early")
  })
})
