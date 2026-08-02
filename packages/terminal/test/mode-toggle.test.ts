import { describe, expect, it } from "vitest"
import { nextMode } from "../src/state/model/terminal-mode-selection"
import { type Mode } from "../src/state/model/terminal-state"

const key = (name: string) => ({
  name,
  sequence: name,
  ctrl: false,
  alt: false,
  meta: false,
  shift: false,
  eventType: "press" as const,
})

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

  it("opens, turns, commits, and animates the selector through update messages", () => {
    const opened = ViewState.update(ViewState.initial("/work", "medium"), { _tag: "ModeSelectorOpened" })
    expect(opened.modePicker).toMatchObject({ open: true, selected: 1 })
    const turned = ViewState.update(opened, { _tag: "ModeTurned", offset: 1 })
    expect(turned.modePicker).toMatchObject({ open: true, selected: 2, from: 1, fromPosition: 1, turnTick: 0 })
    const committed = ViewState.update(turned, { _tag: "ModeCommitted" })
    expect(committed.mode).toBe("high")
    expect(committed.modeCommit).toEqual({ from: "medium", to: "high", tick: 0 })
    expect(ViewState.update(committed, { _tag: "AnimationTicked" }).modeCommit?.tick).toBe(1)
  })

  it("retargets from the current eased slide position and completes every commit glyph", () => {
    let model = ViewState.update(ViewState.initial("/work", "medium"), { _tag: "ModeSelectorOpened" })
    model = ViewState.update(model, { _tag: "ModeTurned", offset: 1 })
    model = ViewState.update(model, { _tag: "AnimationTicked" })
    const retargeted = ViewState.update(model, { _tag: "ModeTurned", offset: 1 })
    expect(retargeted.modePicker.fromPosition).toBeGreaterThan(1)
    expect(retargeted.modePicker.fromPosition).toBeLessThan(2)
    let commit = ViewState.update({ ...retargeted, mode: "medium" }, { _tag: "ModeCommitted", selected: 3 })
    for (let tick = 0; tick <= "medium".length + "ultra".length + 1; tick += 1)
      commit = ViewState.update(commit, { _tag: "AnimationTicked" })
    expect(commit.modeCommit).toBeUndefined()
  })

  it("keeps escape as a non-committing close", () => {
    const opened = ViewState.update(ViewState.initial("/work", "medium"), { _tag: "ModeSelectorOpened" })
    const closed = ViewState.update(opened, { _tag: "KeyPressed", key: key("escape") })
    expect(closed.mode).toBe("medium")
    expect(closed.modePicker.open).toBe(false)
  })
})
