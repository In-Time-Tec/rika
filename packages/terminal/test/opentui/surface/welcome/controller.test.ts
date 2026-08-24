import { expect, test } from "vitest"
import { WelcomeController } from "../../../../src/opentui/surface/welcome/controller"
import { orbGeometry, orbRows } from "../../../../src/opentui/surface/welcome/orb"

const host = { clock: { setInterval: () => 0, clearInterval: () => {} } as never, destroyed: () => false }

test("records a strike at the clicked cell and decays it away", () => {
  const controller = new WelcomeController(host)
  controller.strike(160, 44, 40, 12)
  expect(controller.impulses).toHaveLength(1)
  expect(controller.impulses[0]?.startPhase).toBe(0)
  const geometry = orbGeometry(160, 44)
  const idle = orbRows(geometry, 0, []).join("")
  const struck = orbRows(geometry, 0, controller.impulses).join("")
  expect(struck).not.toEqual(idle)
  for (let tick = 0; tick < 400; tick += 1) controller.advance()
  expect(controller.impulses).toEqual([])
})

test("superposes multiple strikes", () => {
  const controller = new WelcomeController(host)
  controller.strike(160, 44, 30, 10)
  controller.advance()
  controller.strike(160, 44, 60, 16)
  expect(controller.impulses.map((impulse) => impulse.startPhase)).toEqual([0, 1])
})

test("clears impulses when the welcome surface unmounts", () => {
  const controller = new WelcomeController(host)
  controller.strike(160, 44, 30, 10)
  controller.clear()
  expect(controller.impulses).toEqual([])
})
