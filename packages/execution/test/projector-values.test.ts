import { describe, expect, it } from "@effect/vitest"
import { bounded, boundedHead } from "../src/projection/values"

describe("projector value bounds", () => {
  it("keeps the tail for streamed text so the newest content survives", () => {
    const value = `${"a".repeat(100)}TAIL`
    const result = bounded(value, 10)
    expect(result.endsWith("TAIL")).toBe(true)
    expect(result.length).toBe(10)
  })

  it("keeps the head for tool output so a file read does not lose its first lines", () => {
    const value = `HEAD${"a".repeat(100)}`
    const result = boundedHead(value, 10)
    expect(result.startsWith("HEAD")).toBe(true)
    expect(result.endsWith("…")).toBe(true)
    expect(result.length).toBe(10)
  })

  it("returns short values unchanged", () => {
    expect(boundedHead("short", 100)).toBe("short")
    expect(bounded("short", 100)).toBe("short")
  })
})
