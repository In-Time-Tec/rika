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
/**
 * Long enough that the collector sweeps at least once inside the run. A shorter run samples one
 * rising sawtooth tooth and reports its height as retention, which is what made this gate fail on
 * about half its runs against a server whose live set never grew.
 */
const turnCount = 30

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

/**
 * The interactive client now requires a hosted account before it spawns its role tree, so this
 * Darwin-only gate cannot reach the process tree it measures until a test double hosts the
 * authenticated flow. Run it explicitly with RIKA_IDLE_GATE=1 once that fixture exists.
 */
const idleGateRunnable = process.platform === "darwin" && Bun.env.RIKA_IDLE_GATE === "1"

test.skipIf(!idleGateRunnable)(
  "does not retain physical memory across a held multi-turn session",
  () =>
    run(
      Effect.gen(function* () {
        /**
         * One run long enough to contain a collector sweep, rather than two short runs medianed
         * together. Two runs that each sample a single rising sawtooth tooth agree with each other
         * and are both wrong; a run that spans a sweep measures what actually survived it.
         */
        const observation = yield* observeHeldSession()
        for (const role of roles) {
          const series = turnSeries(observation, role)
          const growth = retainedGrowthMebibytes(series.physicalFootprintMebibytes)
          const diagnostics = `physical=[${series.physicalFootprintMebibytes.map((value) => value.toFixed(0)).join(", ")}], RSS=[${series.rssMebibytes.map((value) => value.toFixed(0)).join(", ")}]`
          expect(
            growth,
            `${role} retained physical growth ${growth.toFixed(1)} MiB; ${diagnostics}`,
          ).toBeLessThanOrEqual(retainedGrowthCeiling)
        }
        expect(observation.survivingPids).toEqual([])
      }),
    ),
  300_000,
)

test.skipIf(!idleGateRunnable)(
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
