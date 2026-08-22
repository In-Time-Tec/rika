import * as BunServices from "@effect/platform-bun/BunServices"
import { live } from "@effect/vitest"
import { Effect, Layer, Scope } from "effect"
import { expect } from "vitest"
import { observeProcesses } from "../src/platform/performance-process-table"

/**
 * The interactive client now requires a hosted account before it spawns its role tree, so this
 * Darwin-only gate cannot observe the roles it terminates until a test double hosts the
 * authenticated flow. Run it explicitly with RIKA_PERFORMANCE_GATE=1 once that fixture exists.
 */
const performanceGateRunnable = process.platform === "darwin" && Bun.env.RIKA_PERFORMANCE_GATE === "1"

const isRunning = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

live.skipIf(!performanceGateRunnable)(
  "terminates every isolated process role after observation",
  () =>
    Effect.gen(function* () {
      const scope = yield* Scope.Scope
      const services = yield* Layer.buildWithScope(BunServices.layer, scope)
      const observation = yield* Effect.scoped(observeProcesses().pipe(Effect.provide(services)))
      yield* Effect.sleep("100 millis")
      if (process.platform !== "darwin") {
        expect(observation.roles).toEqual([])
        expect(observation.unsupportedReason).toBeDefined()
        return
      }
      expect(observation.roles.map((role) => role.role)).toEqual(["launcher", "interactive", "server"])
      for (const role of observation.roles) expect(isRunning(role.pid)).toBe(false)
    }),
  30_000,
)
