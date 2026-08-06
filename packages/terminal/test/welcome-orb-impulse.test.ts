import { expect, test } from "vitest"
import { WelcomeController } from "../src/opentui/surface/opentui-welcome-controller"
import { orbGeometry, orbRows } from "../src/opentui/surface/opentui-welcome-orb"

const host = { clock: { setInterval: () => 0, clearInterval: () => {} } as never, destroyed: () => false }

test("records a strike at the clicked cell and decays it away", () => {
  const controller = new WelcomeController(host)
  controller.strike(12, 5)
  expect(controller.impulses).toEqual([{ column: 12, row: 5, startPhase: 0 }])
  const geometry = orbGeometry(160, 44)
  const idle = orbRows(geometry, 0, []).join("")
  const struck = orbRows(geometry, 0, controller.impulses).join("")
  expect(struck).not.toEqual(idle)
  for (let tick = 0; tick < 400; tick += 1) controller.advance()
  expect(controller.impulses).toEqual([])
})

test("superposes multiple strikes", () => {
  const controller = new WelcomeController(host)
  controller.strike(8, 4)
  controller.advance()
  controller.strike(30, 9)
  expect(controller.impulses.map((impulse) => impulse.startPhase)).toEqual([0, 1])
})

test("clears impulses when the welcome surface unmounts", () => {
  const controller = new WelcomeController(host)
  controller.strike(3, 3)
  controller.clear()
  expect(controller.impulses).toEqual([])
})
