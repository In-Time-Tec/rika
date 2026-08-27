import { describe, expect, it } from "vitest"
import { nextMode } from "../../../src/state/mode/selection"
import { initial, type Mode, withModeConfiguration } from "../../../src/state/model"
import { update } from "../../../src/state/reducer/model"

describe("mode cycling", () => {
  const modes = ["low", "medium", "high", "ultra"] as const

  it("advances through every mode and wraps", () => {
    expect(nextMode("low", modes)).toBe("medium")
    expect(nextMode("medium", modes)).toBe("high")
    expect(nextMode("high", modes)).toBe("ultra")
    expect(nextMode("ultra", modes)).toBe("low")
  })

  it("returns to the starting mode after a full cycle", () => {
    for (const start of modes) {
      let mode: Mode = start
      for (let step = 0; step < modes.length; step += 1) mode = nextMode(mode, modes)
      expect(mode).toBe(start)
    }
  })

  it("cycles entirely custom mode names", () => {
    expect(nextMode("review", ["quick", "review", "ship"])).toBe("ship")
  })

  it("keeps an explicit mode active while a valid remembered mode opens as the next picker selection", () => {
    const route = { name: "model", effort: "medium", fast: false, contextWindow: 100, reserveTokens: 10 }
    const configured = withModeConfiguration(initial("/work", "ship"), {
      routes: {
        quick: { main: route, oracle: route },
        review: { main: route, oracle: route },
        ship: { main: route, oracle: route },
      },
      defaultMode: "quick",
      rememberedMode: "review",
    })
    expect(configured.mode).toBe("ship")
    expect(update(configured, { _tag: "ModeSelectorOpened" }).modePicker.selected).toBe(1)
  })

  it("ignores a stale remembered mode when the picker opens", () => {
    const route = { name: "model", effort: "medium", fast: false, contextWindow: 100, reserveTokens: 10 }
    const configured = withModeConfiguration(initial("/work", "ship"), {
      routes: {
        quick: { main: route, oracle: route },
        ship: { main: route, oracle: route },
      },
      defaultMode: "quick",
      rememberedMode: "removed",
    })
    expect(configured.rememberedMode).toBeUndefined()
    expect(update(configured, { _tag: "ModeSelectorOpened" }).modePicker.selected).toBe(1)
  })
})
