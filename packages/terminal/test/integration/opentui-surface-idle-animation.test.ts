import { createTestRenderer, ManualClock } from "@opentui/core/testing"
import { expect, test } from "vitest"
import { Effect } from "effect"
import { Surface } from "../../src/opentui/surface/opentui-surface"
import { spinnerInterval } from "../../src/opentui/rendering/opentui-spinner"
import { initial, type Model } from "../../src/state/model/terminal-state"
import { openTui } from "./opentui-surface-characterization-1-support"

const settled = (): Model => ({
  ...initial("/work", "high"),
  width: 120,
  height: 40,
  entries: [{ role: "assistant", text: "settled answer", turnId: "turn-1" }],
})

const welcoming = (): Model => ({ ...settled(), entries: [], blocks: [], items: [] })

interface AnimationProbe {
  readonly surface: Surface
  readonly animationClock: ManualClock
  readonly animationRenders: () => number
}

const withSurface = <A>(model: Model, use: (probe: AnimationProbe) => A) =>
  Effect.gen(function* () {
    const rendererClock = new ManualClock()
    const animationClock = new ManualClock()
    const setup = yield* openTui(() =>
      createTestRenderer({ width: model.width, height: model.height, clock: rendererClock }),
    )
    const surface = new Surface(
      setup.renderer,
      { key: () => undefined, resize: () => undefined },
      { clock: animationClock },
    )
    try {
      surface.update(model)
      const renderer = setup.renderer as unknown as { requestRender: () => void }
      const request = renderer.requestRender.bind(renderer)
      let renders = 0
      renderer.requestRender = () => {
        renders += 1
        request()
      }
      return use({ surface, animationClock, animationRenders: () => renders })
    } finally {
      surface.destroy()
      setup.renderer.destroy()
    }
  })

test("runs no animation timer and requests no frame while the surface is settled and idle", () =>
  Effect.runPromise(
    withSurface(settled(), ({ surface, animationClock, animationRenders }) => {
      const before = surface.animationDiagnostics()
      expect(before.loaderRunning).toBe(false)
      expect(before.welcomeRunning).toBe(false)
      animationClock.advance(spinnerInterval * 1_000)
      const after = surface.animationDiagnostics()
      expect(after.loaderRunning).toBe(false)
      expect(after.welcomeRunning).toBe(false)
      expect(after.loaderPhase).toBe(before.loaderPhase)
      expect(after.welcomePhase).toBe(before.welcomePhase)
      expect(animationRenders()).toBe(0)
    }),
  ))

test("advances loader frames only while the model is animating and stops when it settles", () =>
  Effect.runPromise(
    withSurface(settled(), ({ surface, animationClock, animationRenders }) => {
      surface.update({ ...settled(), busy: true })
      expect(surface.animationDiagnostics().loaderRunning).toBe(true)

      animationClock.advance(spinnerInterval * 10)
      const busy = surface.animationDiagnostics()
      expect(busy.loaderPhase).toBe(10)
      expect(animationRenders()).toBeGreaterThan(0)

      surface.update(settled())
      expect(surface.animationDiagnostics().loaderRunning).toBe(false)
      const settledRenders = animationRenders()
      animationClock.advance(spinnerInterval * 1_000)
      expect(surface.animationDiagnostics().loaderPhase).toBe(busy.loaderPhase)
      expect(animationRenders()).toBe(settledRenders)
    }),
  ))

test("stops the welcome orb timer once the transcript is no longer empty", () =>
  Effect.runPromise(
    withSurface(welcoming(), ({ surface, animationClock, animationRenders }) => {
      expect(surface.animationDiagnostics().welcomeRunning).toBe(true)
      animationClock.advance(spinnerInterval * 10)
      const welcomePhase = surface.animationDiagnostics().welcomePhase
      expect(welcomePhase).toBe(10)

      surface.update(settled())
      expect(surface.animationDiagnostics().welcomeRunning).toBe(false)
      const settledRenders = animationRenders()
      animationClock.advance(spinnerInterval * 1_000)
      expect(surface.animationDiagnostics().welcomePhase).toBe(welcomePhase)
      expect(animationRenders()).toBe(settledRenders)
    }),
  ))

test("releases every animation timer on destroy", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const rendererClock = new ManualClock()
      const animationClock = new ManualClock()
      const setup = yield* openTui(() => createTestRenderer({ width: 120, height: 40, clock: rendererClock }))
      const surface = new Surface(
        setup.renderer,
        { key: () => undefined, resize: () => undefined },
        { clock: animationClock },
      )
      surface.update({ ...welcoming(), busy: true })
      expect(surface.animationDiagnostics().loaderRunning).toBe(true)
      expect(surface.animationDiagnostics().welcomeRunning).toBe(true)

      surface.destroy()
      const released = surface.animationDiagnostics()
      expect(released.loaderRunning).toBe(false)
      expect(released.welcomeRunning).toBe(false)
      animationClock.advance(spinnerInterval * 1_000)
      expect(surface.animationDiagnostics().loaderPhase).toBe(released.loaderPhase)
      expect(surface.animationDiagnostics().welcomePhase).toBe(released.welcomePhase)
      setup.renderer.destroy()
    }),
  ))

test("settles the welcome orb after its intro and then runs no timer at all", () =>
  Effect.runPromise(
    withSurface(welcoming(), ({ surface, animationClock, animationRenders }) => {
      expect(surface.animationDiagnostics().welcomeRunning).toBe(true)
      animationClock.advance(spinnerInterval * 1_000)
      const quiet = surface.animationDiagnostics()
      expect(quiet.welcomeRunning).toBe(false)

      const settledRenders = animationRenders()
      animationClock.advance(spinnerInterval * 10_000)
      expect(surface.animationDiagnostics().welcomePhase).toBe(quiet.welcomePhase)
      expect(animationRenders()).toBe(settledRenders)
    }),
  ))

test("keeps a settled welcome orb settled across ordinary model updates", () =>
  Effect.runPromise(
    withSurface(welcoming(), ({ surface, animationClock, animationRenders }) => {
      animationClock.advance(spinnerInterval * 1_000)
      expect(surface.animationDiagnostics().welcomeRunning).toBe(false)
      const quiet = surface.animationDiagnostics()

      surface.update({ ...welcoming(), input: "typing", cursor: 6 })
      expect(surface.animationDiagnostics().welcomeRunning).toBe(false)
      const settledRenders = animationRenders()
      animationClock.advance(spinnerInterval * 1_000)
      expect(surface.animationDiagnostics().welcomePhase).toBe(quiet.welcomePhase)
      expect(animationRenders()).toBe(settledRenders)
    }),
  ))

const goaling = (startedAtMillis = 0): Model => ({
  ...settled(),
  goal: { objective: "land R4", status: "active", startedAtMillis },
})

test("runs no goal timer and requests no frame while no goal exists", () =>
  Effect.runPromise(
    withSurface(settled(), ({ surface, animationClock, animationRenders }) => {
      const before = surface.animationDiagnostics()
      expect(before.goalRunning).toBe(false)
      animationClock.advance(spinnerInterval * 1_000)
      const after = surface.animationDiagnostics()
      expect(after.goalRunning).toBe(false)
      expect(after.goalPhase).toBe(before.goalPhase)
      expect(animationRenders()).toBe(0)
    }),
  ))

test("animates the goal icon only while a goal is active and freezes the moment it completes", () =>
  Effect.runPromise(
    withSurface(settled(), ({ surface, animationClock, animationRenders }) => {
      surface.update(goaling())
      expect(surface.animationDiagnostics().goalRunning).toBe(true)

      animationClock.advance(spinnerInterval * 10)
      const active = surface.animationDiagnostics()
      expect(active.goalPhase).toBe(10)
      expect(animationRenders()).toBeGreaterThan(0)

      surface.update({ ...goaling(), goal: { objective: "land R4", status: "complete", startedAtMillis: 0 } })
      expect(surface.animationDiagnostics().goalRunning).toBe(false)
      const completedRenders = animationRenders()
      animationClock.advance(spinnerInterval * 1_000)
      expect(surface.animationDiagnostics().goalPhase).toBe(active.goalPhase)
      expect(animationRenders()).toBe(completedRenders)
    }),
  ))

test("keeps the goal timer stopped for a paused goal that is still present in the model", () =>
  Effect.runPromise(
    withSurface(settled(), ({ surface, animationClock, animationRenders }) => {
      surface.update({ ...goaling(), goal: { objective: "bounded", status: "paused", startedAtMillis: 0 } })
      expect(surface.animationDiagnostics().goalRunning).toBe(false)
      const pausedRenders = animationRenders()
      animationClock.advance(spinnerInterval * 1_000)
      expect(surface.animationDiagnostics().goalPhase).toBe(0)
      expect(animationRenders()).toBe(pausedRenders)
    }),
  ))

test("releases the goal timer on destroy", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const rendererClock = new ManualClock()
      const animationClock = new ManualClock()
      const setup = yield* openTui(() => createTestRenderer({ width: 120, height: 40, clock: rendererClock }))
      const surface = new Surface(
        setup.renderer,
        { key: () => undefined, resize: () => undefined },
        { clock: animationClock },
      )
      surface.update(goaling())
      expect(surface.animationDiagnostics().goalRunning).toBe(true)

      surface.destroy()
      const released = surface.animationDiagnostics()
      expect(released.goalRunning).toBe(false)
      animationClock.advance(spinnerInterval * 1_000)
      expect(surface.animationDiagnostics().goalPhase).toBe(released.goalPhase)
      setup.renderer.destroy()
    }),
  ))
