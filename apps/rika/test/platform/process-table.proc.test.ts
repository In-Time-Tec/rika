import * as BunServices from "@effect/platform-bun/BunServices"
import { live } from "@effect/vitest"
import { Config, Effect, Layer, Scope } from "effect"
import { kill, platform } from "node:process"
import { expect } from "vitest"
import { observeProcesses } from "../../src/platform/process-table"

const performanceGateRunnable = Effect.runSync(
  Config.boolean("RIKA_PERFORMANCE_GATE").pipe(
    Config.withDefault(false),
    Effect.map((enabled) => platform !== "darwin" || enabled),
  ),
)

const isRunning = (pid: number) => {
  try {
    kill(pid, 0)
    return true
  } catch {
    return false
  }
}

live.skipIf(!performanceGateRunnable)(
  "reports unsupported sampling or terminates the isolated client after observation",
  () =>
    Effect.gen(function* () {
      const scope = yield* Scope.Scope
      const services = yield* Layer.buildWithScope(BunServices.layer, scope)
      const observation = yield* Effect.scoped(observeProcesses().pipe(Effect.provide(services)))
      if (platform !== "darwin") {
        expect("client" in observation ? observation.client : undefined).toBeUndefined()
        expect(observation.unsupportedReason).toContain("requires Darwin")
        expect(observation.executableBytes).toBeGreaterThan(0)
        return
      }
      yield* Effect.sleep("100 millis")
      expect("client" in observation ? observation.client : undefined).toBeDefined()
      if ("client" in observation && observation.client !== undefined)
        expect(isRunning(observation.client.pid)).toBe(false)
    }),
  30_000,
)
