import { describe, expect, it } from "vitest"
import { nextMode } from "../src/state/model/terminal-mode-selection"
import { type Mode } from "../src/state/model/terminal-state"

describe("mode cycling", () => {
  it("advances through every mode and wraps", () => {
    expect(nextMode("low")).toBe("medium")
    expect(nextMode("medium")).toBe("high")
    expect(nextMode("high")).toBe("ultra")
    expect(nextMode("ultra")).toBe("low")
  })

  it("returns to the starting mode after a full cycle", () => {
    const modes = ["low", "medium", "high", "ultra"] as const
    for (const start of modes) {
      let mode: Mode = start
      for (let step = 0; step < modes.length; step += 1) mode = nextMode(mode)
      expect(mode).toBe(start)
    }
  })
})
