import { expect, test } from "vitest"
import { initial } from "../src/state/model/terminal-state"
import { canSubmit, update } from "../src/state/reducer/terminal-state-reducer"
import { modePickerContent } from "../src/opentui/surface/opentui-composer-region"
import { welcomeContent } from "../src/opentui/surface/opentui-surface-content"

const key = (name: string) => ({
  name,
  sequence: name === "return" ? "\r" : name,
  ctrl: false,
  alt: false,
  meta: false,
  shift: false,
})

const text = (chunks: ReadonlyArray<{ readonly text: string }>) => chunks.map((chunk) => chunk.text).join("")

test("mode selection is ViewState-owned with eased turns and a draining commit animation", () => {
  let model = update(initial("/work", "medium"), { _tag: "ModeSelectorOpened" })
  expect(model.modePicker).toMatchObject({ open: true, selected: 1 })
  model = update(model, { _tag: "ModeTurned", offset: 1 })
  expect(model.modePicker).toMatchObject({ selected: 2, turnTick: 0 })
  expect(text(modePickerContent(model, 54).chunks)).toContain("╾")
  model = update(model, { _tag: "AnimationTicked" })
  expect(model.modePicker.turnTick).toBe(1)
  model = update(model, { _tag: "ModeCommitted" })
  expect(model.mode).toBe("high")
  expect(model.modePicker.open).toBe(false)
  expect(model.modeCommit).toMatchObject({ from: "medium", to: "high", tick: 0 })
  for (let index = 0; index < 12; index += 1) model = update(model, { _tag: "AnimationTicked" })
  expect(model.modeCommit).toBeUndefined()
})

test("retains the authoritative root context reading while a following turn waits", () => {
  const contextUsage = {
    _tag: "Available" as const,
    inputTokens: 20_000,
    contextWindow: 272_000,
    reserveTokens: 13_600,
  }
  const selected = { ...initial("/work"), currentThreadId: "thread", contextUsage }
  const waiting = update(selected, { _tag: "TurnStarted", turnId: "turn-2", prompt: "continue" })
  expect(waiting.contextUsage).toEqual(contextUsage)
  expect(waiting.activity).toEqual({ _tag: "Waiting" })
})

test("keeps a typed draft intact and blocks submission while a thread is loading", () => {
  let model = update(initial("/work"), { _tag: "ComposerReplaced", text: "keep this draft" })
  model = update(model, { _tag: "ThreadOpenRequested" })
  expect(canSubmit(model)).toBe(false)
  const afterEnter = update(model, { _tag: "KeyPressed", key: key("return") })
  expect(afterEnter.input).toBe("keep this draft")
  expect(afterEnter.history).toEqual([])
  expect(canSubmit(update(afterEnter, { _tag: "ThreadOpenCompleted" }))).toBe(true)
})

test("centers the welcome orb and copy as one group with mode-colored intensity tiers", () => {
  const medium = welcomeContent(120, 30, 0, "medium")
  const high = welcomeContent(120, 30, 0, "high")
  const mediumText = text(medium.chunks)
  expect(mediumText).toContain("Welcome to Rika")
  const copyLine = mediumText.split("\n").find((line) => line.includes("Welcome to Rika"))!
  expect(copyLine.indexOf("Welcome to Rika") - copyLine.search(/[·:•●]/u)).toBeLessThan(60)
  const mediumColors = new Set(
    medium.chunks.filter((chunk) => /[·:•●]/u.test(chunk.text)).map((chunk) => String(chunk.fg)),
  )
  const highColors = new Set(high.chunks.filter((chunk) => /[·:•●]/u.test(chunk.text)).map((chunk) => String(chunk.fg)))
  expect(mediumColors.size).toBeGreaterThan(2)
  expect(highColors).not.toEqual(mediumColors)
})
