import { describe, expect, it } from "@effect/vitest"
import { goalFrames, spinnerFrames, statusSpinnerFrames } from "../../../src/opentui/rendering/spinner"
import { goalAnimationActive, goalIndicatorVisible } from "../../../src/opentui/surface/content"
import { formatGoalElapsed } from "../../../src/state/goal"
import { initial, type Model } from "../../../src/state/model"
import { update } from "../../../src/state/reducer/model"

const model = (goal?: Model["goal"], width = 120): Model => ({
  ...initial("/work", "high"),
  width,
  height: 40,
  goal,
})
const active = { objective: "land R4", status: "active" as const, startedAtMillis: 0 }

describe("goal frame set", () => {
  it("is its own frame set, disjoint from the loader and status spinners", () => {
    const sets = [goalFrames, spinnerFrames, statusSpinnerFrames]
    for (const [index, left] of sets.entries())
      for (const right of sets.slice(index + 1)) expect(left.filter((frame) => right.includes(frame))).toEqual([])
    expect(goalFrames.length).toBeGreaterThan(1)
  })
})

describe("formatGoalElapsed", () => {
  it.each([
    [0, "0s"],
    [59_000, "59s"],
    [60_000, "1m"],
    [3_540_000, "59m"],
    [3_600_000, "1h"],
    [82_800_000, "23h"],
    [86_400_000, "1 day"],
    [172_800_000, "2 days"],
  ])("formats %i ms as %s", (millis, expected) => {
    expect(formatGoalElapsed(millis)).toBe(expected)
  })

  it("never renders a negative elapsed for a clock that moved backwards", () => {
    expect(formatGoalElapsed(-5_000)).toBe("0s")
  })
})

describe("goalAnimationActive", () => {
  it.each([
    [undefined, false],
    [{ ...active, status: "active" as const }, true],
    [{ ...active, status: "paused" as const }, false],
    [{ ...active, status: "complete" as const }, false],
    [{ ...active, status: "errored" as const }, false],
  ])("is %o -> %s", (goal, expected) => {
    expect(goalAnimationActive(model(goal))).toBe(expected)
  })
})

describe("goalIndicatorVisible", () => {
  it("hides the indicator below the width the context meter needs", () => {
    expect(goalIndicatorVisible(model(active, 24))).toBe(true)
    expect(goalIndicatorVisible(model(active, 23))).toBe(false)
  })

  it("hides the indicator whenever no goal is active, at any width", () => {
    expect(goalIndicatorVisible(model(undefined, 200))).toBe(false)
    expect(goalIndicatorVisible(model({ ...active, status: "paused" }, 200))).toBe(false)
  })
})

describe("GoalChanged", () => {
  it("sets and clears the goal without touching anything else in the model", () => {
    const before = model()
    const withGoal = update(before, { _tag: "GoalChanged", goal: active })
    expect(withGoal.goal).toEqual(active)
    expect({ ...withGoal, goal: undefined }).toEqual({ ...before, goal: undefined })
    expect(update(withGoal, { _tag: "GoalChanged" }).goal).toBeUndefined()
  })
})
