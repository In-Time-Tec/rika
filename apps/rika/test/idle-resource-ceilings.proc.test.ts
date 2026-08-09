import * as BunServices from "@effect/platform-bun/BunServices"
import { fileURLToPath } from "node:url"
import { Effect, Layer, Scope } from "effect"
import { expect, test } from "vitest"
import { observeIdleProcessTree, type IdleRole } from "./idle-process-observation"

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url))

const idleCpuCeiling: Readonly<Record<IdleRole, number>> = {
  client: 5,
  interactive: 5,
  server: 15,
}

const idleRssCeiling: Readonly<Record<IdleRole, number>> = {
  client: 400,
  interactive: 600,
  server: 700,
}

const rssGrowthCeiling = 150
const turnGrowthCeiling = 60

const median = (values: ReadonlyArray<number>): number => {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.floor(sorted.length / 2)]!
}

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices | Scope.Scope>) =>
  Effect.runPromise(
    Effect.scoped(Effect.flatMap(Layer.build(BunServices.layer), (context) => Effect.provide(effect, context))),
  )

/**
 * A Server keeps about twenty-five megabytes of every interactive turn, which a long session feels
 * and no other gate sees. This is deliberately red: the ceiling describes what the product should
 * do, and raising it to match what the product does would retire the only thing measuring it.
 */
test.skipIf(process.platform !== "darwin").fails(
  "holds a Server's size steady across turns rather than keeping part of each one",
  () =>
    run(
      Effect.gen(function* () {
        const observation = yield* observeIdleProcessTree({
          repositoryRoot,
          samples: 1,
          sampleMillis: 500,
          readyTimeoutMillis: 60_000,
          settleMillis: 1_000,
          turns: ["turn one", "turn two", "turn three", "turn four", "turn five", "turn six"],
          turnSettleMillis: 4_000,
        })
        const perTurn = observation.perTurnServerRss
        const half = Math.ceil(perTurn.length / 2)
        const growth = Math.max(...perTurn.slice(half)) - Math.max(...perTurn.slice(0, half))
        expect(
          growth,
          `server RSS across turns [${perTurn.map((value) => value.toFixed(0)).join(", ")}] MiB`,
        ).toBeLessThanOrEqual(turnGrowthCeiling)
      }),
    ),
  240_000,
)

test.skipIf(process.platform !== "darwin")(
  "holds every idle process role under its CPU and memory ceiling and leaves nothing running after shutdown",
  () =>
    run(
      Effect.gen(function* () {
        const observation = yield* observeIdleProcessTree({
          repositoryRoot,
          samples: 5,
          sampleMillis: 2_000,
          readyTimeoutMillis: 60_000,
          settleMillis: 8_000,
          turns: ["idle gate turn one", "idle gate turn two", "idle gate turn three"],
          turnSettleMillis: 4_000,
        })
        expect(observation.series.map((entry) => entry.role).sort()).toEqual(["client", "interactive", "server"])
        for (const entry of observation.series) {
          const cpuSeries = entry.cpuPercent.map((value) => value.toFixed(1)).join(", ")
          const rssSeries = entry.rssMebibytes.map((value) => value.toFixed(0)).join(", ")
          const sustainedCpu = median(entry.cpuPercent)
          expect(
            sustainedCpu,
            `${entry.role} sustained idle CPU ${sustainedCpu.toFixed(1)}% over [${cpuSeries}]`,
          ).toBeLessThanOrEqual(idleCpuCeiling[entry.role])

          const peakRss = Math.max(...entry.rssMebibytes)
          expect(peakRss, `${entry.role} idle RSS [${rssSeries}] MiB`).toBeLessThanOrEqual(idleRssCeiling[entry.role])

          const growth = entry.rssMebibytes.at(-1)! - Math.min(...entry.rssMebibytes)
          expect(
            growth,
            `${entry.role} idle RSS growth ${growth.toFixed(1)} MiB over [${rssSeries}]`,
          ).toBeLessThanOrEqual(rssGrowthCeiling)
        }
        expect(observation.survivingPids).toEqual([])
      }),
    ),
  240_000,
)
