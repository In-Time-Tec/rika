import { DateTime, Effect } from "effect"
import type { BenchBaseline } from "./benchmark-baseline-model"
import type { BenchMeasurement } from "./benchmark-measurement"

const metricsFromMeasurement = (measurement: BenchMeasurement): BenchBaseline["metrics"] => ({
  eventsPerSec: { value: measurement.eventsPerSec, direction: "higher-is-better" },
  foldCpuSeconds: { value: measurement.foldCpuSeconds, direction: "lower-is-better" },
  persistCpuSeconds: { value: measurement.persistCpuSeconds, direction: "lower-is-better" },
  commitLatencyMsP50: { value: measurement.commitLatencyMsP50, direction: "lower-is-better" },
  commitLatencyMsP99: { value: measurement.commitLatencyMsP99, direction: "lower-is-better" },
  debounceCommitLatencyMsP50: {
    value: measurement.debounceCommitLatencyMsP50,
    direction: "lower-is-better",
  },
})

export const baselineMetricsFromMeasurement = (measurement: BenchMeasurement): BenchBaseline["metrics"] =>
  metricsFromMeasurement(measurement)

export const measurementToBaseline = Effect.fn("Bench.measurementToBaseline")(function* (
  name: string,
  measurement: BenchMeasurement,
) {
  const now = yield* DateTime.now
  return {
    version: 1 as const,
    name,
    eventCount: measurement.eventCount,
    commitBatch: measurement.commitBatch,
    recordedAt: DateTime.formatIso(now),
    host: `${process.platform}-${process.arch}`,
    metrics: metricsFromMeasurement(measurement),
  } satisfies BenchBaseline
})
