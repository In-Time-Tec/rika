import { expect, test } from "vitest"
import { WelcomeController } from "../src/opentui/surface/opentui-welcome-controller"
import { orbGeometry, orbRows } from "../src/opentui/surface/opentui-welcome-orb"

test("records a strike at the clicked cell and decays it away", () => {
  const controller = new WelcomeController()
  controller.strike(160, 44, 40, 12, 0)
  expect(controller.impulses).toHaveLength(1)
  expect(controller.impulses[0]?.startPhase).toBe(0)
  const geometry = orbGeometry(160, 44)
  const idle = orbRows(geometry, 0, []).join("")
  const struck = orbRows(geometry, 0, controller.impulses).join("")
  expect(struck).not.toEqual(idle)
  controller.expire(400)
  expect(controller.impulses).toEqual([])
})

test("superposes multiple strikes", () => {
  const controller = new WelcomeController()
  controller.strike(160, 44, 30, 10, 0)
  controller.strike(160, 44, 60, 16, 1)
  expect(controller.impulses.map((impulse) => impulse.startPhase)).toEqual([0, 1])
})

test("clears impulses when the welcome surface unmounts", () => {
  const controller = new WelcomeController()
  controller.strike(160, 44, 30, 10, 0)
  controller.clear()
  expect(controller.impulses).toEqual([])
})
