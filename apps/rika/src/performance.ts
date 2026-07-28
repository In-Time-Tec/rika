import {
  performanceEvaluation as evaluateTui,
  type PerformanceMetric,
  type PerformancePhase,
} from "@rika/tui/performance"
import { DateTime, Effect } from "effect"

const targetPasses = (target: NonNullable<PerformanceMetric["target"]>, value: number): boolean => {
  if (target.operator === "lte") return value <= target.value
  if (target.operator === "gte") return value >= target.value
  return value === target.value
}

const measured = (
  id: string,
  unit: PerformanceMetric["unit"],
  value: number,
  target?: PerformanceMetric["target"],
): PerformanceMetric =>
  target === undefined
    ? { id, unit, value, status: "measured" }
    : { id, unit, value, target, status: "measured", pass: targetPasses(target, value) }

const unsupported = (id: string, unit: PerformanceMetric["unit"], reason: string): PerformanceMetric => ({
  id,
  unit,
  status: "unsupported",
  pass: false,
  reason,
})

export const performanceEvaluation = Effect.gen(function* () {
  const generatedAt = yield* DateTime.now
  const rss = new Map<PerformancePhase, number>()
  const heap = new Map<PerformancePhase, number>()
  const observe = (phase: PerformancePhase) => {
    Bun.gc(true)
    const memory = process.memoryUsage()
    rss.set(phase, memory.rss / 1_048_576)
    heap.set(phase, memory.heapUsed / 1_048_576)
  }
  const wallStartedAt = performance.now()
  const cpuBefore = process.cpuUsage()
  const tui = yield* evaluateTui({ observe })
  const wallMilliseconds = performance.now() - wallStartedAt
  const cpu = process.cpuUsage(cpuBefore)
  const cpuPercent = ((cpu.user + cpu.system) / 1_000 / wallMilliseconds) * 100
  const startedRss = rss.get("started")!
  const loadedRss = rss.get("loaded")!
  const interactionRss = rss.get("interactions-completed")!
  const completedRss = rss.get("completed")!
  const metrics: Array<PerformanceMetric> = [
    ...tui.metrics,
    measured("process.rss-before", "mebibytes", startedRss),
    measured("process.rss-loaded", "mebibytes", loadedRss, { operator: "lte", value: 500 }),
    measured("process.rss-interaction-growth", "mebibytes", interactionRss - loadedRss, {
      operator: "lte",
      value: 10,
    }),
    measured("process.rss-after", "mebibytes", completedRss, { operator: "lte", value: 500 }),
    measured("process.heap-before", "mebibytes", heap.get("started")!),
    measured("process.heap-loaded", "mebibytes", heap.get("loaded")!),
    measured(
      "process.heap-interaction-growth",
      "mebibytes",
      heap.get("interactions-completed")! - heap.get("loaded")!,
      {
        operator: "lte",
        value: 10,
      },
    ),
    measured("process.heap-after", "mebibytes", heap.get("completed")!),
    measured("evaluation.cpu", "percent", cpuPercent),
    measured("evaluation.duration", "milliseconds", wallMilliseconds),
    unsupported("process.combined-idle-rss", "mebibytes", "The in-process renderer does not start a resident."),
    unsupported("process.idle-cpu", "percent", "The deterministic workload is not an idle observation."),
    unsupported("process.active-navigation-cpu", "percent", "The deterministic workload runs without user pacing."),
    unsupported("tui.real-terminal-frame", "milliseconds", "A real PTY evidence capture was not supplied."),
    unsupported("resident.restart-recovery", "milliseconds", "The in-process renderer does not start a resident."),
    unsupported(
      "process.cold-launch.p95",
      "milliseconds",
      "The deterministic renderer does not launch a release process tree.",
    ),
    unsupported(
      "process.warm-launch.p95",
      "milliseconds",
      "The deterministic renderer does not launch an interactive process.",
    ),
    unsupported(
      "thread.persisted-open.p50",
      "milliseconds",
      "The synthetic workload does not read a persisted Thread.",
    ),
    unsupported(
      "thread.persisted-open.p95",
      "milliseconds",
      "The synthetic workload does not read a persisted Thread.",
    ),
    unsupported("thread.reconciled-relay-events", "count", "Relay is not started by this deterministic renderer."),
    unsupported("thread.reconciled-historical-tokens", "count", "Relay is not started by this deterministic renderer."),
    unsupported(
      "thread.current-selection-database-reads",
      "count",
      "Persistence is not started by this deterministic renderer.",
    ),
    unsupported(
      "thread.current-selection-relay-reads",
      "count",
      "Relay is not started by this deterministic renderer.",
    ),
    unsupported(
      "thread.current-selection-payload-bytes",
      "count",
      "Transport is not started by this deterministic renderer.",
    ),
    unsupported("tui.dropped-frames", "count", "The OpenTUI test renderer does not expose real-terminal frame drops."),
    unsupported(
      "process.open-close-cycle-rss-growth",
      "mebibytes",
      "The deterministic workload does not open persisted Threads.",
    ),
    unsupported(
      "process.one-hour-idle-rss-growth",
      "mebibytes",
      "The standard evaluation does not run a one-hour soak.",
    ),
  ]
  const failed = metrics.filter(
    (metric) => metric.status === "measured" && metric.target !== undefined && metric.pass === false,
  ).length
  const unsupportedCount = metrics.filter((metric) => metric.status === "unsupported").length
  return {
    schemaVersion: 1,
    generatedAt: DateTime.formatIso(generatedAt),
    evidence: tui.evidence,
    workload: tui.workload,
    process: { platform: process.platform, architecture: process.arch, bun: Bun.version },
    metrics,
    overall: {
      pass: failed === 0 && unsupportedCount === 0,
      measured: metrics.length - unsupportedCount,
      unsupported: unsupportedCount,
      failed,
    },
  }
})
