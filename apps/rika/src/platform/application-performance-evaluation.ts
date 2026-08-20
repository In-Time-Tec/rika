import {
  performanceEvaluation as evaluateTui,
  type PerformanceMetric,
  type PerformancePhase,
} from "@rika/terminal/terminal-performance-evaluation"
import { DateTime, Effect } from "effect"
import { type ProcessObservation } from "./performance-platform"
import { observeProcesses } from "./performance-process-table"

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
  const processes: ProcessObservation = yield* observeProcesses().pipe(
    Effect.orElseSucceed(() => ({
      roles: [],
      executableBytes: { launcher: 0, interactive: 0, server: 0 },
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
    ...(["launcher", "interactive", "server"] as const).map((role) => {
      const observation = processes.roles.find((candidate) => candidate.role === role)
      let target = 250
      if (role === "launcher") target = 75
      if (role === "interactive") target = 175
      return observation === undefined
        ? unsupported(
            `process.${role}.idle-rss`,
            "mebibytes",
            role === "launcher" && processes.roles.some((candidate) => candidate.role === "interactive")
              ? "The packaged launcher replaces its process image with the interactive runtime before idle sampling."
              : (processes.unsupportedReason ?? `${role} was not observed.`),
          )
        : measured(`process.${role}.idle-rss`, "mebibytes", observation.rssMebibytes, {
            operator: "lte",
            value: target,
          })
    }),
    processes.roles.some((role) => role.role === "interactive") &&
    processes.roles.some((role) => role.role === "server")
      ? measured(
          "process.combined-idle-rss",
          "mebibytes",
          processes.roles.reduce((total, role) => total + role.rssMebibytes, 0),
          { operator: "lte", value: 350 },
        )
      : unsupported(
          "process.combined-idle-rss",
          "mebibytes",
          processes.unsupportedReason ?? "Process roles were incomplete.",
        ),
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
    ...(["launcher", "interactive", "server"] as const).map((role) =>
      measured(`executable.${role}.file-bytes`, "count", processes.executableBytes[role]),
    ),
    processes.startupToRolePresenceMilliseconds === undefined
      ? unsupported(
          "process.startup-to-role-presence",
          "milliseconds",
          processes.unsupportedReason ?? "No process tree became ready.",
        )
      : measured("process.startup-to-role-presence", "milliseconds", processes.startupToRolePresenceMilliseconds),
    unsupported("process.active-navigation-cpu", "percent", "The deterministic workload runs without user pacing."),
    unsupported("tui.real-terminal-frame", "milliseconds", "A real PTY evidence capture was not supplied."),
    unsupported("server.restart-recovery", "milliseconds", "The in-process renderer does not start a server."),
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
      processRoles: processes.roles.map(({ role, pid, executable }) => ({ role, pid, executable })),
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
