import { describe, expect, it } from "vitest"
import { clampThreadTitle, threadTitleLimit } from "../src/thread-title"

describe("thread titles", () => {
  it("caps every surface at the same limit", () => {
    expect(clampThreadTitle("a".repeat(200))).toHaveLength(threadTitleLimit)
  })

  it("normalizes titles to one visible line", () => {
    expect(clampThreadTitle("  # Finish the release\n\nYou are finishing\ttoday\u001b  ")).toBe(
      "# Finish the release You are finishing today",
    )
    expect(clampThreadTitle("Family 👨‍👩‍👧‍👦")).toBe("Family 👨‍👩‍👧‍👦")
  })

  it("never splits a surrogate pair", () => {
    const title = clampThreadTitle(`${"a".repeat(threadTitleLimit - 1)}😀tail`)
    expect([...title]).toHaveLength(threadTitleLimit)
    expect(title.endsWith("😀")).toBe(true)
    expect(title.isWellFormed()).toBe(true)
    expect(`${"a".repeat(threadTitleLimit - 1)}😀tail`.slice(0, threadTitleLimit).isWellFormed()).toBe(false)
  })

  it("leaves short titles untouched", () => {
    expect(clampThreadTitle("short")).toBe("short")
  })
})
