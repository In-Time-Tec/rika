import * as BunServices from "@effect/platform-bun/BunServices"
import { fileURLToPath } from "node:url"
import { Effect, Layer, Scope } from "effect"
import { expect, test } from "vitest"
import { observeIdleProcessTree, type IdleObservation, type IdleRole } from "./idle-process-observation"
import { retainedGrowthMebibytes } from "./idle-retained-growth"

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url))
const roles: ReadonlyArray<IdleRole> = ["client", "interactive", "server"]

const idleCpuCeiling: Readonly<Record<IdleRole, number>> = {
  client: 5,
  interactive: 5,
  server: 15,
}

const idlePhysicalFootprintCeiling: Readonly<Record<IdleRole, number>> = {
  client: 400,
  interactive: 600,
  server: 700,
}

const idlePhysicalGrowthCeiling = 100
const retainedGrowthCeiling = 150
const turnCount = 12

const median = (values: ReadonlyArray<number>): number => {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!
}

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices | Scope.Scope>) =>
  Effect.runPromise(
    Effect.scoped(Effect.flatMap(Layer.build(BunServices.layer), (context) => Effect.provide(effect, context))),
  )

const observeHeldSession = () =>
  observeIdleProcessTree({
    repositoryRoot,
    samples: 1,
    sampleMillis: 500,
    readyTimeoutMillis: 60_000,
    settleMillis: 1_000,
    turns: Array.from({ length: turnCount }, (_, index) => `held session turn ${index + 1}`),
    turnSettleMillis: 4_000,
  })

const turnSeries = (observation: IdleObservation, role: IdleRole) => {
  const series = observation.perTurn.find((entry) => entry.role === role)
  expect(series, `missing ${role} per-turn samples`).toBeDefined()
  expect(series!.physicalFootprintMebibytes).toHaveLength(turnCount)
  return series!
}

test.skipIf(process.platform !== "darwin")(
  "does not retain physical memory across a held multi-turn session",
  () =>
    run(
      Effect.gen(function* () {
        const observations = [yield* observeHeldSession(), yield* observeHeldSession()]
        for (const role of roles) {
          const growthByRun = observations.map((observation) =>
            retainedGrowthMebibytes(turnSeries(observation, role).physicalFootprintMebibytes),
          )
          const aggregateGrowth = median(growthByRun)
          const diagnostics = observations
            .map((observation) => {
              const series = turnSeries(observation, role)
              return `physical=[${series.physicalFootprintMebibytes.map((value) => value.toFixed(0)).join(", ")}], RSS=[${series.rssMebibytes.map((value) => value.toFixed(0)).join(", ")}]`
            })
            .join("; ")
          expect(
            aggregateGrowth,
            `${role} retained physical growth by run [${growthByRun.map((value) => value.toFixed(1)).join(", ")}] MiB; ${diagnostics}`,
          ).toBeLessThanOrEqual(retainedGrowthCeiling)
        }
        for (const observation of observations) expect(observation.survivingPids).toEqual([])
      }),
    ),
  300_000,
)

test.skipIf(process.platform !== "darwin")(
  "holds every idle process role under its CPU and physical-memory ceiling and leaves nothing running",
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
        expect(observation.series.map((entry) => entry.role).sort()).toEqual(roles)
        for (const entry of observation.series) {
          const cpuSeries = entry.cpuPercent.map((value) => value.toFixed(1)).join(", ")
          const physicalSeries = entry.physicalFootprintMebibytes.map((value) => value.toFixed(0)).join(", ")
          const rssSeries = entry.rssMebibytes.map((value) => value.toFixed(0)).join(", ")
          const sustainedCpu = median(entry.cpuPercent)
          expect(
            sustainedCpu,
            `${entry.role} sustained idle CPU ${sustainedCpu.toFixed(1)}% over [${cpuSeries}]`,
          ).toBeLessThanOrEqual(idleCpuCeiling[entry.role])

          const peakPhysicalFootprint = Math.max(...entry.physicalFootprintMebibytes)
          expect(
            peakPhysicalFootprint,
            `${entry.role} idle physical footprint [${physicalSeries}] MiB; RSS diagnostic [${rssSeries}] MiB`,
          ).toBeLessThanOrEqual(idlePhysicalFootprintCeiling[entry.role])

          const physicalGrowth =
            entry.physicalFootprintMebibytes.at(-1)! - Math.min(...entry.physicalFootprintMebibytes)
          expect(
            physicalGrowth,
            `${entry.role} idle physical growth ${physicalGrowth.toFixed(1)} MiB over [${physicalSeries}]; RSS diagnostic [${rssSeries}] MiB`,
          ).toBeLessThanOrEqual(idlePhysicalGrowthCeiling)
        }
        expect(observation.survivingPids).toEqual([])
      }),
    ),
  240_000,
)
