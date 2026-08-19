import { describe, expect, test } from "vitest"
import { fitOverlayHints } from "../src/presentation/terminal/terminal-overlay-hints"

describe("overlay hint fitting", () => {
  test("keeps every label when they all fit", () => {
    const fitted = fitOverlayHints(["copy", "close"], 40)
    expect(fitted).toEqual({ labels: ["copy", "close"], truncated: false })
  })

  test("reports truncation when a label is dropped entirely", () => {
    const fitted = fitOverlayHints(["copy", "close", "expand"], 6)
    expect(fitted.labels.length).toBeLessThan(3)
    expect(fitted.truncated).toBe(true)
  })

  test("ellipsizes a label that only partly fits", () => {
    const fitted = fitOverlayHints(["expand everything"], 8)
    expect(fitted.labels[0]!.endsWith("…")).toBe(true)
    expect(fitted.truncated).toBe(true)
  })

  test("degrades to a single ellipsis in one column", () => {
    expect(fitOverlayHints(["copy"], 1).labels).toEqual(["…"])
  })

  test("fits nothing when there is no room", () => {
    expect(fitOverlayHints(["copy"], 0)).toEqual({ labels: [], truncated: true })
  })

  test("accounts for the two-column separator between labels", () => {
    const fitted = fitOverlayHints(["ab", "cd"], 4)
    expect(fitted.labels.length).toBe(1)
  })
})
