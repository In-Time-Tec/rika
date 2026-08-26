import { describe, expect, test } from "vitest"
import { toastLayout } from "../../../src/presentation/terminal/toast-layout"

describe("toast layout", () => {
  test("sizes the box to the message plus its chrome", () => {
    expect(toastLayout("saved", 80)).toEqual({ right: 2, width: 11, message: "saved" })
  })

  test("never exceeds the available width", () => {
    const layout = toastLayout("a".repeat(200), 40)
    expect(layout.width).toBeLessThanOrEqual(40 - layout.right)
  })

  test("truncates a message that cannot fit its box", () => {
    const layout = toastLayout("a".repeat(200), 20)
    expect(layout.message.length).toBeLessThan(200)
  })

  test("stays valid in a one-column terminal", () => {
    const layout = toastLayout("saved", 1)
    expect(layout.right).toBe(0)
    expect(layout.width).toBeGreaterThanOrEqual(1)
  })

  test("treats a zero or negative width as one column", () => {
    expect(toastLayout("saved", 0).width).toBeGreaterThanOrEqual(1)
  })
})
