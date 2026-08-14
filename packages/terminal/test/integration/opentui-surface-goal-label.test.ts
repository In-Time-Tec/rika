import { createTestRenderer, ManualClock } from "@opentui/core/testing"
import { expect, test } from "vitest"
import { Effect } from "effect"
import { Surface } from "../../src/opentui/surface/opentui-surface"
import { goalFrames, spinnerInterval } from "../../src/opentui/rendering/opentui-spinner"
import { initial, type Model } from "../../src/state/model/terminal-state"
import type { GoalIndicator } from "../../src/state/model/terminal-goal"
import { openTui, styledTextValue } from "./opentui-surface-characterization-1-support"

const base = (width = 120): Model => ({
  ...initial("/work", "high"),
  width,
  height: 40,
  entries: [{ role: "assistant", text: "settled answer", turnId: "turn-1" }],
})
const goal = (status: GoalIndicator["status"] = "active") => ({
  objective: "land R4",
  status,
  startedAtMillis: 0,
})

const withSurface = <A>(use: (input: { readonly surface: Surface; readonly clock: ManualClock }) => A) =>
  Effect.gen(function* () {
    const rendererClock = new ManualClock()
    const clock = new ManualClock()
    const setup = yield* openTui(() => createTestRenderer({ width: 120, height: 40, clock: rendererClock }))
    const surface = new Surface(
      setup.renderer,
      { key: () => undefined, resize: () => undefined },
      { clock, epochMillis: 0, currentTimeMillis: () => clock.now() },
    )
    try {
      return use({ surface, clock })
    } finally {
      surface.destroy()
      setup.renderer.destroy()
    }
  })

const label = (surface: Surface) => styledTextValue(surface.goalLabel.content)

test("renders the goal in the top-left corner only while it is active", () =>
  Effect.runPromise(
    withSurface(({ surface }) => {
      surface.update(base())
      expect(label(surface)).toBe("")

      surface.update({ ...base(), goal: goal() })
      expect(surface.goalLabel.top).toBe(0)
      expect(surface.goalLabel.left).toBe(1)
      expect(label(surface)).toContain("Goal 0s")
      expect(goalFrames.some((frame) => label(surface).includes(frame))).toBe(true)

      surface.update({ ...base(), goal: goal("complete") })
      expect(label(surface)).toBe("")
    }),
  ))

test("advances the goal elapsed time and its own frame set on each tick", () =>
  Effect.runPromise(
    withSurface(({ surface, clock }) => {
      surface.update({ ...base(), goal: goal() })
      const first = label(surface)
      clock.advance(32_000)
      expect(label(surface)).toContain("Goal 32s")
      expect(label(surface)).not.toBe(first)

      surface.update({ ...base(), goal: { ...goal(), startedAtMillis: clock.now() - 2 * 86_400_000 } })
      expect(label(surface)).toContain("Goal 2 days")
    }),
  ))

test("hides the goal indicator on a terminal too narrow for the context meter", () =>
  Effect.runPromise(
    withSurface(({ surface }) => {
      surface.update({ ...base(23), goal: goal() })
      expect(label(surface)).toBe("")

      surface.update({ ...base(24), goal: goal() })
      expect(label(surface)).toContain("Goal")
    }),
  ))

test("never advances the goal frame when the surface is constructed without animation", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const rendererClock = new ManualClock()
      const clock = new ManualClock()
      const setup = yield* openTui(() => createTestRenderer({ width: 120, height: 40, clock: rendererClock }))
      const surface = new Surface(
        setup.renderer,
        { key: () => undefined, resize: () => undefined },
        { clock, animate: false },
      )
      surface.update({ ...base(), goal: goal() })
      expect(surface.animationDiagnostics().goalRunning).toBe(false)
      clock.advance(spinnerInterval * 1_000)
      expect(surface.animationDiagnostics().goalPhase).toBe(0)
      surface.destroy()
      setup.renderer.destroy()
    }),
  ))
