import { describe, expect, it } from "vitest"
import { ViewState, type Mode } from "./support/terminal-state-access"

describe("mode cycling", () => {
  it("advances through every mode and wraps", () => {
    expect(ViewState.nextMode("low")).toBe("medium")
    expect(ViewState.nextMode("medium")).toBe("high")
    expect(ViewState.nextMode("high")).toBe("ultra")
    expect(ViewState.nextMode("ultra")).toBe("low")
  })

  it("returns to the starting mode after a full cycle", () => {
    const modes = ["low", "medium", "high", "ultra"] as const
    for (const start of modes) {
      let mode: Mode = start
      for (let step = 0; step < modes.length; step += 1) mode = ViewState.nextMode(mode)
      expect(mode).toBe(start)
    }
  })
})
