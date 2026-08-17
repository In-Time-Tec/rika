import { describe, expect, it } from "@effect/vitest"
import { animationFamilies, animationFrame, animationIntervalMillis } from "../src/opentui/rendering/opentui-animation-frame"

const timeline = Array.from({ length: 200 }, (_, step) => step * animationIntervalMillis)
const framesFor = (key: string) => timeline.map((millis) => animationFrame(key, millis))

describe("animationFrame", () => {
  it("gives concurrent rows visibly different animations at the same instant", () => {
    const keys = ["tool:read:1", "tool:read:2", "tool:read:3", "subagent:Oracle", "subagent:Task", "cell:9"]
    let collisions = 0
    let comparisons = 0
    for (const millis of timeline) {
      const glyphs = keys.map((key) => animationFrame(key, millis))
      for (let left = 0; left < glyphs.length; left += 1)
        for (let right = left + 1; right < glyphs.length; right += 1) {
          comparisons += 1
          if (glyphs[left] === glyphs[right]) collisions += 1
        }
    }
    expect(collisions / comparisons).toBeLessThan(0.2)
  })

  it("never leaves the status line and the context meter in lockstep", () => {
    expect(framesFor("status")).not.toEqual(framesFor("context-meter"))
  })

  it("keeps each row moving rather than resting on one glyph", () => {
    for (const key of ["status", "goal", "tool:read:1", "subagent:Oracle"])
      expect(new Set(framesFor(key)).size).toBeGreaterThan(1)
  })

  it("is a pure function of identity and elapsed time", () => {
    expect(animationFrame("tool:read:1", 1_234)).toBe(animationFrame("tool:read:1", 1_234))
  })

  it("resolves a frame from one of its declared families", () => {
    const every = new Set(animationFamilies.flatMap((family) => [...family.frames]))
    for (const frame of framesFor("tool:read:1")) expect(every.has(frame)).toBe(true)
  })

  it("treats a late frame as the frame its elapsed time names", () => {
    expect(animationFrame("tool:read:1", 5_000)).toBe(animationFrame("tool:read:1", 5_000))
    expect(framesFor("tool:read:1").slice(0, 4)).toEqual(
      [0, 1, 2, 3].map((step) => animationFrame("tool:read:1", step * animationIntervalMillis)),
    )
  })
})
