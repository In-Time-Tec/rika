import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Effect, Layer, pipe } from "effect"
import { Command, Flag } from "effect/unstable/cli"
import { baselinePath, compareBaseline, loadBaseline, saveBaseline } from "./benchmark-baseline"
import { measurementToBaseline } from "./benchmark-baseline-measurement"
import type { BenchMeasurement } from "./benchmark-measurement"
import {
  defaultCommitBatch,
  defaultEventCount,
  MonotonicClock,
  runFoldPersistenceBench,
} from "./fold-persistence-benchmark"
import { median } from "./benchmark-statistics"

const processMonotonicClock = { now: () => process.hrtime.bigint() }

const benchName = "fold-persistence"
const defaultWindows = 3

const formatMetric = (value: number, digits = 2) =>
  Number.isFinite(value) ? value.toLocaleString(undefined, { maximumFractionDigits: digits }) : "n/a"

const aggregateMeasurements = (samples: ReadonlyArray<BenchMeasurement>): BenchMeasurement => {
  const pick = (select: (sample: BenchMeasurement) => number) => median(samples.map(select))
  return {
    eventCount: samples[0]!.eventCount,
    commitBatch: samples[0]!.commitBatch,
    wallSeconds: pick((sample) => sample.wallSeconds),
    eventsPerSec: pick((sample) => sample.eventsPerSec),
    foldCpuSeconds: pick((sample) => sample.foldCpuSeconds),
    persistCpuSeconds: pick((sample) => sample.persistCpuSeconds),
    totalCpuSeconds: pick((sample) => sample.totalCpuSeconds),
    commitLatencyMsP50: pick((sample) => sample.commitLatencyMsP50),
    commitLatencyMsP99: pick((sample) => sample.commitLatencyMsP99),
    debounceCommitLatencyMsP50: pick((sample) => sample.debounceCommitLatencyMsP50),
  }
}

const report = (measurement: BenchMeasurement, foldEventsPerSec: number, windows: number) => {
  const lines = [
    "rika bench: fold/persistence",
    `windows: ${windows} (median)`,
    `events: ${formatMetric(measurement.eventCount, 0)}`,
    `commit batch: ${measurement.commitBatch}`,
    `wall: ${formatMetric(measurement.wallSeconds, 3)} s`,
    `throughput: ${formatMetric(measurement.eventsPerSec, 0)} events/s`,
    `fold throughput: ${formatMetric(foldEventsPerSec, 0)} events/s`,
    `fold cpu: ${formatMetric(measurement.foldCpuSeconds, 3)} s`,
    `persist cpu: ${formatMetric(measurement.persistCpuSeconds, 3)} s`,
    `total cpu: ${formatMetric(measurement.totalCpuSeconds, 3)} s`,
    `commit p50: ${formatMetric(measurement.commitLatencyMsP50, 3)} ms`,
    `commit p99: ${formatMetric(measurement.commitLatencyMsP99, 3)} ms`,
    `debounce commit p50: ${formatMetric(measurement.debounceCommitLatencyMsP50, 3)} ms`,
    "targets: >= 5000 events/s, debounce commit p50 <= 1 ms",
  ]
  return Effect.log(lines.join("\n"))
}

const program = ({
  updateBaseline,
  events: eventCount,
  commitBatch,
  windows,
}: {
  updateBaseline: boolean
  events: number
  commitBatch: number
  windows: number
}) =>
  Effect.gen(function* () {
    if (!Number.isFinite(windows) || windows < 1) return yield* Effect.die("bench --windows must be a positive integer")
    const samples: Array<BenchMeasurement> = []
    const foldRates: Array<number> = []
    let dataRoot = ""
    for (let window = 0; window < windows; window += 1) {
      const result = yield* pipe({ eventCount, commitBatch }, runFoldPersistenceBench, Effect.orDie)
      samples.push(result.measurement)
      foldRates.push(result.foldEventsPerSec)
      dataRoot = result.dataRoot
    }
    const measurement = aggregateMeasurements(samples)
    const foldEventsPerSec = median(foldRates)
    yield* report(measurement, foldEventsPerSec, windows)
    yield* Effect.log(`data root: ${dataRoot}`)
    const path = baselinePath(benchName)
    if (updateBaseline) {
      const baseline = yield* measurementToBaseline(benchName, measurement)
      yield* saveBaseline(path, baseline)
      yield* Effect.log(`baseline updated: ${path}`)
      return
    }
    const baseline = yield* loadBaseline(path)
    const regressions = compareBaseline(baseline, measurement)
    if (regressions.length === 0) {
      yield* Effect.log("baseline gate: pass")
      return
    }
    yield* Effect.logError("baseline gate: fail")
    for (const regression of regressions)
      yield* Effect.logError(
        `${regression.metric}: baseline=${regression.baseline} current=${regression.current} direction=${regression.direction} ratio=${regression.changeRatio.toFixed(3)}`,
      )
    return yield* Effect.die("bench regression exceeded 20% tolerance")
  })

const command = Command.make(
  "bench",
  {
    updateBaseline: Flag.boolean("update-baseline"),
    events: Flag.integer("events").pipe(Flag.withDefault(defaultEventCount)),
    commitBatch: Flag.integer("commit-batch").pipe(Flag.withDefault(defaultCommitBatch)),
    windows: Flag.integer("windows").pipe(Flag.withDefault(defaultWindows)),
  },
  program,
)

const main = Command.run(command, { version: "0.0.0" }).pipe(Effect.orDie)
const services = Layer.mergeAll(BunServices.layer, Layer.succeed(MonotonicClock, processMonotonicClock)).pipe(
  Layer.orDie,
)

if (import.meta.main)
  BunRuntime.runMain(Effect.scoped(Effect.flatMap(Layer.build(services), (context) => Effect.provide(main, context))))
