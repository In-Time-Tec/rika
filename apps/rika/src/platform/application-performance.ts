import {
  performanceEvaluation as evaluateTui,
  type PerformanceMetric,
  type PerformancePhase,
} from "@rika/terminal/terminal-performance-evaluation"
import { DateTime, Effect } from "effect"
import { type ProcessIdentity, type ProcessObservation } from "./performance"
import { observeProcesses } from "./process-table"

const monotonicMilliseconds = () => Number(process.hrtime.bigint()) / 1_000_000

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

export const publicProcessIdentity = ({ pid, executable, runtimeKind }: ProcessIdentity) => ({
  pid,
  runtimeKind,
  executable: executable.split(/[\\/]/).at(-1) ?? "",
})

export const processObservationMetrics = (processes: ProcessObservation): ReadonlyArray<PerformanceMetric> => {
  const client = processes.client
  return [
    client === undefined
      ? unsupported(
          "process.client.idle-rss",
          "mebibytes",
          processes.unsupportedReason ?? "The client was not observed.",
        )
      : measured("process.client.idle-rss", "mebibytes", client.rssMebibytes, { operator: "lte", value: 350 }),
    processes.idleCpuMeanPercent === undefined
      ? unsupported(
          "process.idle-cpu.mean",
          "percent",
          processes.unsupportedReason ?? "No process samples were available.",
        )
      : measured("process.idle-cpu.mean", "percent", processes.idleCpuMeanPercent, { operator: "lte", value: 1 }),
    processes.idleCpuPeakPercent === undefined
      ? unsupported(
          "process.idle-cpu.peak",
          "percent",
          processes.unsupportedReason ?? "No process samples were available.",
        )
      : measured("process.idle-cpu.peak", "percent", processes.idleCpuPeakPercent, { operator: "lte", value: 3 }),
    measured("executable.client.file-bytes", "count", processes.executableBytes),
    processes.startupToProcessPresenceMilliseconds === undefined
      ? unsupported(
          "process.startup-to-client-presence",
          "milliseconds",
          processes.unsupportedReason ?? "No client process became ready.",
        )
      : measured("process.startup-to-client-presence", "milliseconds", processes.startupToProcessPresenceMilliseconds),
  ]
}

export const performanceEvaluation = Effect.gen(function* () {
  const generatedAt = yield* DateTime.now
  const processes: ProcessObservation = yield* observeProcesses().pipe(
    Effect.orElseSucceed(() => ({
      executableBytes: 0,
      unsupportedReason: "The platform process observer failed before it could collect reliable evidence.",
    })),
  )
  const rss = new Map<PerformancePhase, number>()
  const heap = new Map<PerformancePhase, number>()
  const observe = (phase: PerformancePhase) => {
    Bun.gc(true)
    const memory = process.memoryUsage()
    rss.set(phase, memory.rss / 1_048_576)
    heap.set(phase, memory.heapUsed / 1_048_576)
  }
  const wallStartedAt = monotonicMilliseconds()
  const cpuBefore = process.cpuUsage()
  const tui = yield* evaluateTui({ observe })
  const wallMilliseconds = monotonicMilliseconds() - wallStartedAt
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
    ...processObservationMetrics(processes),
    unsupported("process.active-navigation-cpu", "percent", "The deterministic workload runs without user pacing."),
    unsupported("tui.real-terminal-frame", "milliseconds", "A real PTY evidence capture was not supplied."),
    unsupported("process.cold-launch.p95", "milliseconds", "One isolated launch cannot honestly establish a p95."),
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
    unsupported("thread.reconciled-run-events", "count", "TenetKit is not started by this deterministic renderer."),
    unsupported(
      "thread.reconciled-historical-tokens",
      "count",
      "TenetKit is not started by this deterministic renderer.",
    ),
    unsupported(
      "thread.current-selection-database-reads",
      "count",
      "Persistence is not started by this deterministic renderer.",
    ),
    unsupported(
      "thread.current-selection-run-reads",
      "count",
      "TenetKit is not started by this deterministic renderer.",
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
    evidence: {
      renderer: tui.evidence,
      processIdentity: processes.client === undefined ? undefined : publicProcessIdentity(processes.client),
      processTree: {
        descendants: processes.descendantCount,
      },
      processSamples: processes.sampleCount,
      terminal: {
        columns: processes.terminalColumns,
        rows: processes.terminalRows,
      },
      isolation: "Effect-scoped temporary HOME and databases",
    },
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
