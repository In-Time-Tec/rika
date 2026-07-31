import { expect, test } from "vitest"
import { isInteractiveClientLaunch } from "../src/client-main"

test("noninteractive client commands own SIGINT interruption", () => {
  expect(isInteractiveClientLaunch([])).toBe(true)
  expect(isInteractiveClientLaunch(["--execute"])).toBe(false)
  expect(isInteractiveClientLaunch(["run", "task"])).toBe(false)
  expect(isInteractiveClientLaunch(["review", "task"])).toBe(false)
  expect(isInteractiveClientLaunch(["threads", "last"])).toBe(false)
  expect(isInteractiveClientLaunch(["workflow", "deploy"])).toBe(false)
})

test("interactive client launches preserve child signal handling", () => {
  expect(isInteractiveClientLaunch(undefined)).toBe(true)
  expect(isInteractiveClientLaunch(["--mode", "medium"])).toBe(true)
})
